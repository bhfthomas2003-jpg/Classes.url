/* ============================================================================
   database.js — IndexedDB wrapper for Mr. Thomas' Academy offline mode
   Database: mta_offline_db  (versioned; see MIGRATIONS below)
   This file does not talk to the network or to Code.gs. It only stores
   and retrieves local data. sync.js is the only file that calls the API.
   ============================================================================ */
const DB_NAME = "mta_offline_db";
const DB_VERSION = 1;

/* Object stores and their key paths. Add new stores/indexes here and bump
   DB_VERSION + add a branch in the upgrade handler to migrate safely. */
const STORE_DEFS = {
  students:      { keyPath: "studentId" },
  assignments:   { keyPath: "assignmentId", indexes: [["grade_subject", ["grade","subject"]]] },
  resources:     { keyPath: "resourceId",  indexes: [["grade_subject", ["grade","subject"]]] },
  drafts:        { keyPath: "id" },                                   // id = studentId::assignmentId
  submissionQueue:{ keyPath: "localId", autoIncrement: true, indexes: [["status","status"]] },
  announcements: { keyPath: "announcementId" },
  settings:      { keyPath: "key" },
  syncLog:       { keyPath: "id", autoIncrement: true }
};

let _dbPromise = null;
function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORE_DEFS)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, {
            keyPath: def.keyPath,
            autoIncrement: !!def.autoIncrement
          });
          (def.indexes || []).forEach(([idxName, keyPath]) => {
            store.createIndex(idxName, keyPath, { unique: false });
          });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Database upgrade blocked — close other tabs of this app and reload."));
  });
  return _dbPromise;
}

function tx(storeName, mode) {
  return openDb().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

const DB = {
  async put(store, value) {
    const s = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      const r = s.put(value);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async bulkPut(store, values) {
    const s = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      values.forEach(v => s.put(v));
      s.transaction.oncomplete = () => res(true);
      s.transaction.onerror = () => rej(s.transaction.error);
    });
  },
  async get(store, key) {
    const s = await tx(store, "readonly");
    return new Promise((res, rej) => {
      const r = s.get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  },
  async getAll(store, query) {
    const s = await tx(store, "readonly");
    return new Promise((res, rej) => {
      const r = s.getAll(query);
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },
  async getAllByIndex(store, indexName, value) {
    const s = await tx(store, "readonly");
    return new Promise((res, rej) => {
      const r = s.index(indexName).getAll(value);
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },
  async delete(store, key) {
    const s = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      const r = s.delete(key);
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
    });
  },
  async clear(store) {
    const s = await tx(store, "readwrite");
    return new Promise((res, rej) => {
      const r = s.clear();
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
    });
  }
};

/* ---- settings helpers (single-value convenience) ---- */
async function setSetting(key, value) { return DB.put("settings", { key, value }); }
async function getSetting(key, fallback) {
  const row = await DB.get("settings", key);
  return row ? row.value : (fallback === undefined ? null : fallback);
}

/* ---- storage usage estimate, for the "manage downloads" screen ---- */
async function storageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    } catch (e) { /* ignore */ }
  }
  return { usage: null, quota: null };
}

async function logSync(message, ok) {
  try { await DB.put("syncLog", { id: Date.now() + Math.random(), ts: new Date().toISOString(), message, ok: !!ok }); }
  catch (e) { /* best effort */ }
}
