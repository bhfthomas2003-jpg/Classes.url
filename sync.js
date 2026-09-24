/* ============================================================================
   sync.js — the ONLY file that talks to the network / Code.gs.
   It calls the existing, unmodified backend actions:
     loginStudent, getStudentDashboard, getAssignments, getResources,
     getAnnouncements, submitAssignment
   No new Code.gs action is required for any of these. (Fetching the actual
   bytes of a private Drive attachment is the one thing that is NOT possible
   without a new Code.gs endpoint — see downloadAssignmentAttachment() below
   for exactly why, and what a future endpoint would need to look like.)
   ============================================================================ */

const SyncStatus = { PENDING: "pending", SYNCING: "syncing", SYNCED: "synced", FAILED: "failed" };

let _online = navigator.onLine;
const _onlineListeners = [];
function onConnectivityChange(fn) { _onlineListeners.push(fn); }
function isOnline() { return _online; }
function _setOnline(v) {
  if (v === _online) return;
  _online = v;
  _onlineListeners.forEach(fn => { try { fn(_online); } catch (e) {} });
}
window.addEventListener("online", () => { _setOnline(true); verifyRealConnectivity(); });
window.addEventListener("offline", () => _setOnline(false));

/* navigator.onLine only means "has a network interface", not "can reach the
   internet" (e.g. connected to Wi-Fi with no data). Before trusting it for a
   sync attempt, do one cheap real request. */
async function verifyRealConnectivity() {
  if (!navigator.onLine) { _setOnline(false); return false; }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(OFFLINE_CONFIG.googleAppsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "getAnnouncements", grade: "10", token: "" }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    _setOnline(res.ok || res.status === 200);
    return _online;
  } catch (e) {
    _setOnline(false);
    return false;
  }
}

function getToken() {
  return localStorage.getItem(OFFLINE_CONFIG.sessionStorageKey) || "";
}
function setToken(tok) {
  if (tok) localStorage.setItem(OFFLINE_CONFIG.sessionStorageKey, tok);
}

async function apiCall(action, data = {}, needsAuth = true) {
  if (!(await verifyRealConnectivity())) throw new Error("OFFLINE");
  const res = await fetch(OFFLINE_CONFIG.googleAppsScriptUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, ...data, token: needsAuth ? getToken() : "" })
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "Request failed");
  return json.data;
}

/* ---------------------------------------------------------------- login --- */
async function loginAndCache(studentId, password) {
  const data = await apiCall("loginStudent", { studentId, password }, false);
  setToken(data.token);
  await DB.put("students", { studentId: data.profile.studentId, ...data.profile, cachedAt: new Date().toISOString() });
  await setSetting("activeStudentId", data.profile.studentId);
  await setSetting("tokenSavedAt", Date.now());
  return data.profile;
}

/* Session tokens last 12 hours (CONFIG.SESSION_HOURS in Code.gs). We can't
   know locally whether a cached token is still valid without asking the
   server, so any sync attempt just tries it and, on an auth error, asks the
   student to log in again (never guesses / never fabricates a session). */
async function tokenLooksFresh() {
  const savedAt = await getSetting("tokenSavedAt", 0);
  return !!getToken() && (Date.now() - savedAt) < 11.5 * 60 * 60 * 1000; // small safety margin under 12h
}

/* ------------------------------------------------------- download data --- */
/* A lightweight content fingerprint, used purely as a client-side "version"
   so we don't re-download an assignment/resource whose content hasn't
   changed. Code.gs has no version field of its own (adding one would mean
   modifying Code.gs), so this is computed locally from the fields that
   matter to a student. */
function fingerprint(obj, fields) {
  const s = fields.map(f => String(obj[f] ?? "")).join("|");
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return "v" + (h >>> 0).toString(36);
}
const ASSIGNMENT_FIELDS = ["title","description","instructions","dueDate","maxScore","attachmentUrl","attachmentName","status"];
const RESOURCE_FIELDS = ["title","description","category","fileUrl","fileName","status"];

async function downloadForGrade(grade) {
  const [asgRes, resRes, annRes, dashRes] = await Promise.all([
    apiCall("getAssignments", { grade }),
    apiCall("getResources", { grade }),
    apiCall("getAnnouncements", { grade }),
    apiCall("getStudentDashboard", { studentId: (await activeProfile())?.studentId })
  ]);

  const assignments = (asgRes.assignments || []).map(a => ({ ...a, _fp: fingerprint(a, ASSIGNMENT_FIELDS), _downloadedAt: new Date().toISOString() }));
  const resources = (resRes.resources || []).map(r => ({ ...r, _fp: fingerprint(r, RESOURCE_FIELDS), _downloadedAt: new Date().toISOString() }));
  const announcements = (annRes.announcements || []).map(x => ({ ...x, _cachedAt: new Date().toISOString() }));

  await DB.bulkPut("assignments", assignments);
  await DB.bulkPut("resources", resources);
  await DB.bulkPut("announcements", announcements);
  await setSetting("lastSyncAt_" + grade, new Date().toISOString());
  await setSetting("lastDashboard", dashRes);
  return { assignments, resources, announcements, dashboard: dashRes };
}

async function activeProfile() {
  const id = await getSetting("activeStudentId", null);
  if (!id) return null;
  return DB.get("students", id);
}

/* ------------------------------------------------ attachment download --- */
/*
 * Assignment/resource attachments live in the teacher's private Google
 * Drive. saveBase64FileToFolder_() in Code.gs stores them and returns
 * file.getUrl() — a Drive VIEW page, e.g.
 *   https://drive.google.com/file/d/<id>/view?usp=drivesdk
 * A view page requires the viewer to be signed into Google and holding
 * Drive permission on that file; it cannot be fetch()'d cross-origin from
 * this app the way a plain file can, so we cannot reliably cache the actual
 * PDF/Word/image bytes for true offline viewing without server help.
 *
 * What WOULD make this possible, without weakening security: a new
 * Code.gs action — say getAssignmentAttachment_(p) — that mirrors the
 * getStudentPhoto_ pattern already used for profile photos: it checks
 * requireStudent_(p), confirms the file belongs to an assignment/resource
 * for that student's own grade, then returns the bytes as base64. That is
 * a Code.gs change, so it is intentionally NOT included here.
 *
 * Until such an endpoint exists, this function attempts a best-effort
 * direct fetch (works only for the rare case a file happens to be shared
 * "Anyone with the link"), and otherwise marks the attachment as
 * "instructions cached, file needs a connection" rather than silently
 * failing or pretending it downloaded.
 */
function driveFileId(url) {
  const s = String(url || "");
  const m = s.match(/\/d\/([-\w]{20,})/) || s.match(/[?&]id=([-\w]{20,})/);
  return m ? m[1] : "";
}
async function tryDownloadAttachment(url, name) {
  const id = driveFileId(url);
  if (!id) return { ok: false, reason: "NO_FILE_ID" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, { signal: ctrl.signal });
    clearTimeout(t);
    const type = res.headers.get("content-type") || "";
    if (!res.ok || type.includes("text/html")) {
      // Google returned its sign-in / permission page, not the file.
      return { ok: false, reason: "NOT_PUBLIC" };
    }
    const blob = await res.blob();
    if (blob.size > 15 * 1024 * 1024) return { ok: false, reason: "TOO_LARGE" };
    return { ok: true, blob, name };
  } catch (e) {
    return { ok: false, reason: "NETWORK" };
  }
}

/* --------------------------------------------------------- submission --- */
async function queueOfflineSubmission({ studentId, assignmentId, assignmentTitle, assignmentVersion, answerText, files }) {
  const localId = await DB.put("submissionQueue", {
    studentId, assignmentId, assignmentTitle, assignmentVersion,
    answerText: answerText || "",
    files: files || [],           // [{name, type, blob}]
    createdAt: new Date().toISOString(),
    attempt: 1,
    status: SyncStatus.PENDING,
    syncAttempts: 0,
    lastError: "",
    serverSubmissionId: null,
    syncedAt: null
  });
  return localId;
}

let _syncing = false;
async function processQueue(onProgress) {
  if (_syncing) return { ranAlready: true };
  _syncing = true;
  try {
    if (!(await verifyRealConnectivity())) return { synced: 0, failed: 0, skipped: true };
    const items = await DB.getAllByIndex("submissionQueue", "status", SyncStatus.PENDING);
    const failedRetryable = (await DB.getAllByIndex("submissionQueue", "status", SyncStatus.FAILED))
      .filter(x => x.syncAttempts < 8);
    const queue = [...items, ...failedRetryable];
    let synced = 0, failed = 0;

    for (const item of queue) {
      item.status = SyncStatus.SYNCING;
      await DB.put("submissionQueue", item);
      onProgress && onProgress(item);
      try {
        if (!(await tokenLooksFresh())) throw new Error("AUTH_STALE");
        const { fileData, fileName, fileType } = await buildSubmissionFile(item);
        const result = await apiCall("submitAssignment", {
          assignmentId: item.assignmentId, fileData, fileName, fileType
        });
        item.status = SyncStatus.SYNCED;
        item.serverSubmissionId = result.submission ? result.submission.submissionId : null;
        item.syncedAt = new Date().toISOString();
        item.files = []; // free the stored blobs now that the server has the combined file
        await DB.put("submissionQueue", item);
        await logSync(`Synced ${item.assignmentTitle || item.assignmentId}`, true);
        synced++;
      } catch (err) {
        item.status = SyncStatus.FAILED;
        item.syncAttempts = (item.syncAttempts || 0) + 1;
        item.lastError = err && err.message === "AUTH_STALE"
          ? "Your session needs you to log in again before this can sync."
          : (err && err.message) || "Unknown error";
        await DB.put("submissionQueue", item);
        await logSync(`Sync failed for ${item.assignmentTitle || item.assignmentId}: ${item.lastError}`, false);
        failed++;
      }
      onProgress && onProgress(item);
    }
    await setSetting("lastSyncRun", new Date().toISOString());
    return { synced, failed, skipped: false };
  } finally {
    _syncing = false;
  }
}

let _autoTimer = null;
function startAutoSync(onProgress) {
  stopAutoSync();
  _autoTimer = setInterval(() => { if (isOnline()) processQueue(onProgress); }, OFFLINE_CONFIG.autoSyncIntervalSeconds * 1000);
  onConnectivityChange(online => { if (online) processQueue(onProgress); });
}
function stopAutoSync() { if (_autoTimer) clearInterval(_autoTimer); _autoTimer = null; }
