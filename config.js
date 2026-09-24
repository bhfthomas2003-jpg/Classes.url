/* ============================================================================
   config.js — single place to keep the offline app in sync with the main
   portal's backend URL.

   IMPORTANT: this value MUST match APP_CONFIG.googleAppsScriptUrl inside the
   main index.html. It is duplicated here (rather than read from index.html)
   so the offline app has zero dependency on the online file at runtime —
   that's what lets it work with no internet and no server.

   If you ever redeploy Code.gs and get a new /exec URL, update it in BOTH
   places: index.html AND this file.
   ============================================================================ */
const OFFLINE_CONFIG = {
  academyName: "Mr. Thomas' Academy",
  googleAppsScriptUrl: "https://script.google.com/macros/s/AKfycbxEONbImqHPjVdcw5zVo08hDlB22tYhyboOszCPladhUa-_ofcq8hwWFMNDArod7ZyYFQ/exec",
  sessionStorageKey: "mta_session",        // same key index.html uses — lets a student who is
                                            // already logged in on the main portal use offline
                                            // mode immediately, with no second login.
  maxFileSizeMB: 20,
  imagePageMaxPx: 1600,                    // matches the online submit flow's photo size
  maxOfflinePhotos: 10,                    // matches the online submit flow's photo limit
  syncRetryBaseSeconds: 20,                // backoff base for failed-sync retries
  syncRetryMaxSeconds: 600,
  autoSyncIntervalSeconds: 25              // how often we check the queue while online
};
