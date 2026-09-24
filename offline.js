/* ============================================================================
   offline.js — UI controller for the standalone offline app (offline.html).
   Depends on: config.js, database.js, sync.js, assignments.js (loaded first).
   ============================================================================ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const GRADES = ["10","11","12"];
const gnum = g => String(g ?? "").replace(/grade/ig, "").trim();
const gradeLabel = g => { const n = gnum(g); return n ? "Grade " + n : ""; };

let ui = { view: "loading", assignmentId: null, saveTimer: null, profile: null };

async function boot() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./service-worker.js"); } catch (e) { console.warn("SW registration failed", e); }
  }
  await verifyRealConnectivity();
  onConnectivityChange(() => paintStatusPill());
  startAutoSync(() => { if (ui.view === "queue") render(); });

  ui.profile = await activeProfile();
  ui.view = ui.profile ? "dashboard" : "login";
  render();
  paintStatusPill();

  // Retry a real connectivity check periodically even without a browser event.
  setInterval(verifyRealConnectivity, 15000);
}

function paintStatusPill() {
  const el = $("#statusPill");
  if (!el) return;
  el.textContent = isOnline() ? "🟢 Online" : "🟠 Offline Mode";
  el.className = "status-pill " + (isOnline() ? "on" : "off");
}

function go(view, arg) { ui.view = view; if (arg !== undefined) ui.assignmentId = arg; render(); }

async function render() {
  const app = $("#app");
  if (ui.view === "loading") { app.innerHTML = `<div class="empty">Loading…</div>`; return; }
  if (ui.view === "login") { app.innerHTML = await viewLogin(); return; }
  if (ui.view === "dashboard") { app.innerHTML = await viewDashboard(); return; }
  if (ui.view === "assignment") { app.innerHTML = await viewAssignment(ui.assignmentId); wireAssignmentAutosave(); return; }
  if (ui.view === "queue") { app.innerHTML = await viewQueue(); return; }
  if (ui.view === "materials") { app.innerHTML = await viewMaterials(); return; }
  if (ui.view === "announcements") { app.innerHTML = await viewAnnouncements(); return; }
}

/* ------------------------------------------------------------- LOGIN --- */
async function viewLogin() {
  const hasNetwork = isOnline();
  return `
  <div class="hero">
    <img class="logo" src="./icons/icon-96.png" alt="">
    <h2>Offline Mode</h2>
    <p>Log in once while connected. Your assignments and profile are then saved on this device
       so you can keep working with little or no mobile data.</p>
  </div>
  <div class="card">
    ${hasNetwork ? `
      <form id="loginForm" onsubmit="return submitLogin(event)">
        <div class="field"><label>Student ID</label><input id="lgId" required autocomplete="username"></div>
        <div class="field"><label>Password</label><input id="lgPw" type="password" required autocomplete="current-password"></div>
        <button class="btn gold" id="lgBtn">Log in &amp; download my work</button>
      </form>
      <p class="small muted">Already logged in on the main portal in this browser? Just reopen this page — it will pick that up automatically next time you have no saved profile.</p>
    ` : `
      <div class="empty">
        <p><b>No connection, and no student is saved on this device yet.</b></p>
        <p class="small muted">Connect to Wi-Fi or mobile data once, then log in here (or in the main portal) so this
        device can download your assignments for offline use.</p>
      </div>
    `}
  </div>`;
}
async function submitLogin(e) {
  e.preventDefault();
  const btn = $("#lgBtn"); btn.disabled = true; btn.textContent = "Logging in…";
  try {
    const profile = await loginAndCache($("#lgId").value.trim(), $("#lgPw").value);
    ui.profile = profile;
    await downloadForGrade(gnum(profile.grade));
    toast("Logged in and downloaded your work.");
    go("dashboard");
  } catch (err) {
    toast(err.message === "OFFLINE" ? "No connection right now — try again once you're online." : err.message, true);
    btn.disabled = false; btn.textContent = "Log in & download my work";
  }
  return false;
}

/* --------------------------------------------------------- DASHBOARD --- */
async function viewDashboard() {
  const p = ui.profile;
  const grade = gnum(p.grade);
  // Filtered in JS rather than via the compound index: IndexedDB's handling of
  // array-keyPath index ranges is consistent within a browser but this keeps
  // the query trivially correct across all of them.
  const myAssignments = (await DB.getAll("assignments")).filter(a => gnum(a.grade) === grade);
  const queue = await DB.getAll("submissionQueue");
  const myQueue = queue.filter(q => q.studentId === p.studentId);
  const drafts = await DB.getAll("drafts");
  const myDrafts = drafts.filter(d => d.studentId === p.studentId);

  const submittedIds = new Set(myQueue.map(q => q.assignmentId));
  const draftIds = new Set(myDrafts.map(d => d.assignmentId));
  const synced = myQueue.filter(q => q.status === "synced").length;
  const pendingSync = myQueue.filter(q => q.status === "pending" || q.status === "syncing").length;
  const failedSync = myQueue.filter(q => q.status === "failed").length;
  const inProgress = myDrafts.length;
  const available = myAssignments.filter(a => !submittedIds.has(a.assignmentId)).length;

  const lastSync = await getSetting("lastSyncAt_" + grade, null);

  return `
  <div class="hero">
    <img class="logo sm" src="./icons/icon-96.png" alt="">
    <div>
      <h2>Welcome, ${esc(p.fullName)}</h2>
      <p class="small muted">${esc(p.studentId)} • ${esc(gradeLabel(p.grade))}${p.section ? " • Class " + esc(p.section) : ""}</p>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat"><b>${available}</b><span>Available</span></div>
    <div class="stat"><b>${inProgress}</b><span>In Progress</span></div>
    <div class="stat"><b>${pendingSync + failedSync}</b><span>Pending Sync</span></div>
    <div class="stat"><b>${synced}</b><span>Completed</span></div>
  </div>
  <p class="small muted" style="margin:6px 4px 16px">Last synchronization: ${lastSync ? new Date(lastSync).toLocaleString() : "Never — connect and download below"}</p>

  <div class="actions-row">
    <button class="btn gold" onclick="doDownload()" ${isOnline() ? "" : "disabled"}>⬇ Download latest assignments</button>
    <button class="btn light" onclick="go('queue')">Sync queue (${pendingSync + failedSync})</button>
    <button class="btn light" onclick="go('materials')">Learning materials</button>
    <button class="btn light" onclick="go('announcements')">Announcements</button>
  </div>

  <h3 class="section-title">Your assignments</h3>
  <div class="list">
    ${myAssignments.length ? myAssignments.map(a => {
      const q = myQueue.filter(x => x.assignmentId === a.assignmentId).sort((x,y)=>new Date(y.createdAt)-new Date(x.createdAt))[0];
      let chip = `<span class="chip">Not started</span>`;
      if (draftIds.has(a.assignmentId) && !q) chip = `<span class="chip draft">Draft saved</span>`;
      if (q) {
        if (q.status === "synced") chip = `<span class="chip synced">✓ Synced</span>`;
        else if (q.status === "failed") chip = `<span class="chip failed">⚠ Sync failed</span>`;
        else chip = `<span class="chip pending">⏳ Pending Sync</span>`;
      }
      return `<div class="row" onclick="go('assignment','${esc(a.assignmentId)}')">
        <div><b>${esc(a.title)}</b><div class="small muted">${esc(a.subject)} • Due ${esc(a.dueDate || "—")}</div></div>
        ${chip}
      </div>`;
    }).join("") : `<div class="empty">No assignments downloaded yet. Tap "Download latest assignments" while online.</div>`}
  </div>

  <button class="btn text" onclick="doLogout()" style="margin-top:22px">Log out of this device</button>`;
}

async function doDownload() {
  try {
    toast("Downloading…");
    await downloadForGrade(gnum(ui.profile.grade));
    toast("Your assignments are up to date.");
    render();
  } catch (e) {
    toast(e.message === "OFFLINE" ? "No connection right now." : e.message, true);
  }
}
async function doLogout() {
  if (!confirm("Log out of offline mode on this device? Downloaded assignments and any pending offline submissions stay saved until they sync.")) return;
  localStorage.removeItem(OFFLINE_CONFIG.sessionStorageKey);
  await setSetting("activeStudentId", null);
  ui.profile = null;
  go("login");
}

/* -------------------------------------------------------- ASSIGNMENT --- */
async function viewAssignment(id) {
  const a = await DB.get("assignments", id);
  if (!a) return `<div class="empty">This assignment isn't downloaded on this device.</div><button class="btn light" onclick="go('dashboard')">← Back</button>`;
  const p = ui.profile;
  const draft = await loadDraft(p.studentId, id);
  const queueItems = (await DB.getAll("submissionQueue")).filter(q => q.studentId === p.studentId && q.assignmentId === id);
  const latest = queueItems.sort((x,y)=>new Date(y.createdAt)-new Date(x.createdAt))[0];

  const resources = (await DB.getAll("resources")).filter(r => gnum(r.grade) === gnum(a.grade) && r.subject === a.subject);

  return `
  <button class="btn light" onclick="go('dashboard')" style="margin-bottom:12px">← Back to Dashboard</button>
  <div class="hero">
    <h2>${esc(a.title)}</h2>
    <p class="small muted">${esc(a.subject)} • ${esc(gradeLabel(a.grade))} • Due ${esc(a.dueDate || "—")} • Out of ${esc(a.maxScore)}</p>
  </div>

  ${latest ? `<div class="notice ${latest.status}">
    ${latest.status === "synced" ? "✓ Submitted and synced with your teacher." :
      latest.status === "failed" ? "⚠ Submitted offline — sync failed, will retry automatically. You can also retry from the Sync queue." :
      "Submitted offline — waiting for synchronization."}
  </div>` : ""}

  <div class="card">
    <h3>Instructions</h3>
    <p>${esc(a.description || "")}</p>
    ${a.instructions ? `<p>${esc(a.instructions)}</p>` : ""}
    ${a.attachmentUrl ? attachmentRow(a.attachmentUrl, a.attachmentName || "Assignment file") : ""}
  </div>

  ${resources.length ? `<div class="card">
    <h3>Related learning materials</h3>
    ${resources.map(r => `<div class="row-flat"><span>${esc(r.title)}</span>${materialAction(r)}</div>`).join("")}
  </div>` : ""}

  <div class="card">
    <h3>Your answer</h3>
    <textarea id="answerBox" rows="8" placeholder="Type your working / answers here…">${esc(draft?.answerText || "")}</textarea>
    <p class="small muted" id="savedLabel">${draft?.lastSaved ? "Last saved: " + new Date(draft.lastSaved).toLocaleTimeString() : "Not saved yet"}</p>

    <div class="filebox">
      <label>Attach photos of your work (optional, up to ${OFFLINE_CONFIG.maxOfflinePhotos})</label>
      <input id="ansFiles" type="file" accept="image/*" multiple>
    </div>
    <div id="fileList">${renderFileChips(draft?.files || [])}</div>

    <button class="btn green" id="submitBtn" onclick="submitOffline('${esc(id)}')" ${latest && latest.status === "synced" ? "disabled" : ""}>
      ${latest && latest.status === "synced" ? "Already synced" : "Submit"}
    </button>
  </div>`;
}

function attachmentRow(url, name) {
  return `<div class="row-flat"><span>📄 ${esc(name)}</span>
    <button class="btn light sm" onclick="openOrFetchAttachment('${esc(url)}','${esc(name)}',this)">Open</button></div>`;
}
function materialAction(r) {
  if (r._blob) return `<button class="btn light sm" onclick="openCachedBlob('resources','${esc(r.resourceId)}')">Open (saved)</button>`;
  return `<button class="btn light sm" onclick="downloadMaterial('${esc(r.resourceId)}',this)" ${isOnline() ? "" : "disabled"}>Download</button>`;
}
async function openOrFetchAttachment(url, name, btn) {
  if (isOnline()) { window.open(url, "_blank"); return; }
  toast("This file needs a connection to open — it isn't saved on this device.", true);
}
async function downloadMaterial(resourceId, btn) {
  const r = await DB.get("resources", resourceId);
  btn.disabled = true; btn.textContent = "Downloading…";
  const res = await tryDownloadAttachment(r.fileUrl, r.fileName || r.title);
  if (res.ok) {
    r._blob = res.blob; r._blobFetchedAt = new Date().toISOString();
    await DB.put("resources", r);
    toast("Saved for offline use.");
    render();
  } else {
    const why = { NOT_PUBLIC: "this file isn't shared publicly, so it can only be opened while online",
                   TOO_LARGE: "this file is too large to store on this device",
                   NETWORK: "the download didn't go through", NO_FILE_ID: "this file link isn't recognized" }[res.reason] || "it couldn't be saved";
    toast("Couldn't download for offline use — " + why + ".", true);
    btn.disabled = false; btn.textContent = "Download";
  }
}
async function openCachedBlob(store, key) {
  const rec = await DB.get(store, key);
  if (!rec || !rec._blob) return toast("Not saved on this device.", true);
  const url = URL.createObjectURL(rec._blob);
  window.open(url, "_blank");
}

function renderFileChips(files) {
  if (!files.length) return "";
  return `<div class="chips">${files.map((f,i)=>`<span class="filechip">📷 ${esc(f.name)} <button onclick="removeDraftFile(${i})">✕</button></span>`).join("")}</div>`;
}
let _draftFiles = [];
async function removeDraftFile(i) { _draftFiles.splice(i,1); $("#fileList").innerHTML = renderFileChips(_draftFiles); scheduleSave(); }

function wireAssignmentAutosave() {
  loadDraft(ui.profile.studentId, ui.assignmentId).then(d => { _draftFiles = (d && d.files) || []; });
  const box = $("#answerBox");
  if (box) box.addEventListener("input", scheduleSave);
  const fi = $("#ansFiles");
  if (fi) fi.addEventListener("change", async (e) => {
    const incoming = Array.from(e.target.files);
    for (const f of incoming) {
      if (_draftFiles.length >= OFFLINE_CONFIG.maxOfflinePhotos) { toast(`Maximum ${OFFLINE_CONFIG.maxOfflinePhotos} photos.`, true); break; }
      const shrunk = await shrinkImageBlob(f);
      _draftFiles.push({ name: f.name, type: "image/jpeg", blob: shrunk });
    }
    e.target.value = "";
    $("#fileList").innerHTML = renderFileChips(_draftFiles);
    scheduleSave();
  });
}
function scheduleSave() {
  clearTimeout(ui.saveTimer);
  ui.saveTimer = setTimeout(async () => {
    const text = $("#answerBox") ? $("#answerBox").value : "";
    const savedAt = await saveDraft(ui.profile.studentId, ui.assignmentId, { answerText: text, files: _draftFiles });
    const lbl = $("#savedLabel");
    if (lbl) lbl.textContent = "Last saved: " + new Date(savedAt).toLocaleTimeString();
  }, 700);
}
window.addEventListener("beforeunload", () => {
  if (ui.view === "assignment" && $("#answerBox")) {
    // best-effort synchronous-ish save; IndexedDB writes are async so this is not guaranteed,
    // which is exactly why we also autosave on every keystroke (debounced) and on blur.
    saveDraft(ui.profile.studentId, ui.assignmentId, { answerText: $("#answerBox").value, files: _draftFiles });
  }
});

async function submitOffline(assignmentId) {
  const a = await DB.get("assignments", assignmentId);
  const text = $("#answerBox").value;
  await saveDraft(ui.profile.studentId, assignmentId, { answerText: text, files: _draftFiles });

  if (!text.trim() && _draftFiles.length === 0) { toast("Write an answer or attach a photo first.", true); return; }

  const btn = $("#submitBtn"); btn.disabled = true; btn.textContent = "Saving…";
  await queueOfflineSubmission({
    studentId: ui.profile.studentId,
    assignmentId,
    assignmentTitle: a.title,
    assignmentVersion: a._fp,
    answerText: text,
    files: _draftFiles
  });
  await clearDraft(ui.profile.studentId, assignmentId);
  _draftFiles = [];

  if (await verifyRealConnectivity()) {
    btn.textContent = "Syncing…";
    await processQueue();
  }
  render();
}

/* -------------------------------------------------------------- QUEUE --- */
async function viewQueue() {
  const all = (await DB.getAll("submissionQueue")).filter(q => q.studentId === ui.profile.studentId)
    .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const lastRun = await getSetting("lastSyncRun", null);
  return `
  <button class="btn light" onclick="go('dashboard')" style="margin-bottom:12px">← Back to Dashboard</button>
  <div class="hero"><h2>Sync queue</h2><p class="small muted">Last sync attempt: ${lastRun ? new Date(lastRun).toLocaleString() : "—"}</p></div>
  <div class="actions-row"><button class="btn gold" onclick="manualSync()" ${isOnline() ? "" : "disabled"}>🔄 Sync now</button></div>
  <div class="list">
    ${all.length ? all.map(q => `
      <div class="row-flat">
        <div><b>${esc(q.assignmentTitle || q.assignmentId)}</b><div class="small muted">${new Date(q.createdAt).toLocaleString()}${q.lastError ? " • " + esc(q.lastError) : ""}</div></div>
        ${q.status === "synced" ? `<span class="chip synced">✓ Synced</span>` :
          q.status === "failed" ? `<span class="chip failed">⚠ Pending Sync</span>` :
          `<span class="chip pending">⏳ Pending Sync</span>`}
      </div>`).join("") : `<div class="empty">Nothing queued.</div>`}
  </div>`;
}
async function manualSync() { toast("Syncing…"); const r = await processQueue(); toast(r.skipped ? "Still offline." : `Synced ${r.synced}, failed ${r.failed}.`); render(); }

/* ---------------------------------------------------------- MATERIALS --- */
async function viewMaterials() {
  const p = ui.profile;
  const list = (await DB.getAll("resources")).filter(r => gnum(r.grade) === gnum(p.grade));
  return `
  <button class="btn light" onclick="go('dashboard')" style="margin-bottom:12px">← Back to Dashboard</button>
  <div class="hero"><h2>Learning materials</h2><p class="small muted">Downloaded materials stay on this device. New ones only download when you choose them, to save data.</p></div>
  <div class="list">
    ${list.length ? list.map(r => `<div class="row-flat"><div><b>${esc(r.title)}</b><div class="small muted">${esc(r.subject)} • ${esc(r.category)}</div></div>${materialAction(r)}</div>`).join("")
      : `<div class="empty">No materials downloaded. Download assignments first — related materials appear here.</div>`}
  </div>`;
}

/* ------------------------------------------------------ ANNOUNCEMENTS --- */
async function viewAnnouncements() {
  const p = ui.profile;
  const list = (await DB.getAll("announcements")).filter(a => a.audience === "All Students" || gnum(a.grade) === gnum(p.grade))
    .sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
  const lastSync = await getSetting("lastSyncAt_" + gnum(p.grade), null);
  return `
  <button class="btn light" onclick="go('dashboard')" style="margin-bottom:12px">← Back to Dashboard</button>
  <div class="hero"><h2>Announcements</h2><p class="small muted">Last updated: ${lastSync ? new Date(lastSync).toLocaleString() : "—"}</p></div>
  <div class="list">
    ${list.length ? list.map(a => `<div class="row-flat" style="display:block"><b>${esc(a.title)}</b><div class="small muted">${esc(a.message)}</div><div class="small muted" style="margin-top:4px">${new Date(a.publishedAt).toLocaleString()}</div></div>`).join("")
      : `<div class="empty">No announcements cached yet.</div>`}
  </div>`;
}

/* ------------------------------------------------------------- toast --- */
let _toastTimer = null;
function toast(msg, isError) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show" + (isError ? " err" : "");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

boot();
