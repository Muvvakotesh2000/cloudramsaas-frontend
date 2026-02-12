(function () {
  async function getSb() {
    if (window._sbClient) return window._sbClient;

    const cfg = await window.loadAppConfig();
    if (!window.supabase || !window.supabase.createClient) return null;

    window._sbClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return window._sbClient;
  }

  window.getAuthHeaders = async function () {
    const sb = await getSb();
    if (!sb) throw new Error("Supabase not initialized.");

    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error("Session expired. Login again.");

    localStorage.setItem("sb_access_token", session.access_token);
    return { "Authorization": `Bearer ${session.access_token}` };
  };
})();
