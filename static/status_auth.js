(function () {
  // ✅ KEY FIX: Expose a promise that resolves when Supabase is fully ready.
  // All consumers await window.authReady before touching window._sbClient or tokens.
  let _resolveAuthReady;
  window.authReady = new Promise((resolve) => { _resolveAuthReady = resolve; });

  async function initAuth() {
    // Wait for loadAppConfig (config.js must be loaded before this script)
    let cfg;
    for (let i = 0; i < 30; i++) {
      if (window.loadAppConfig) {
        try { cfg = await window.loadAppConfig(); break; } catch {}
      }
      await new Promise(r => setTimeout(r, 200));
    }
    if (!cfg) { console.error("status_auth: config never loaded"); _resolveAuthReady(); return; }

    // Wait for Supabase SDK
    for (let i = 0; i < 30; i++) {
      if (window.supabase?.createClient) break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!window.supabase?.createClient) { console.error("status_auth: Supabase SDK not found"); _resolveAuthReady(); return; }

    window._sbClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

    // Prime the session immediately so the token is cached
    try {
      const { data } = await window._sbClient.auth.getSession();
      if (data?.session?.access_token) {
        localStorage.setItem("sb_access_token", data.session.access_token);
      }
    } catch (e) {
      console.warn("status_auth: initial getSession failed (will retry on demand):", e.message);
    }

    _resolveAuthReady();
  }

  // ✅ Resilient token getter — retries with backoff, falls back to localStorage
  window.getAccessToken = async function () {
    await window.authReady; // wait for init to complete

    const sb = window._sbClient;
    if (sb) {
      for (let i = 1; i <= 5; i++) {
        try {
          const result = await Promise.race([
            sb.auth.getSession(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000))
          ]);
          const token = result?.data?.session?.access_token;
          if (token) {
            localStorage.setItem("sb_access_token", token);
            return token;
          }
        } catch (e) {
          console.warn(`getAccessToken attempt ${i} failed:`, e.message);
          if (i < 5) await new Promise(r => setTimeout(r, 500 * i));
        }
      }
    }

    // Fallback: localStorage (may be slightly stale but functional)
    const ls = localStorage.getItem("sb_access_token");
    if (ls) return ls;

    throw new Error("Session expired or not found. Please login again.");
  };

  window.getAuthHeaders = async function () {
    const token = await window.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  };

  // Kick off init immediately (don't wait for DOMContentLoaded — we want it ASAP)
  initAuth();
})();