// frontend/static/config.js
window.__APP_CONFIG__ = null;

window.loadAppConfig = async function () {
  if (window.__APP_CONFIG__) return window.__APP_CONFIG__;

  const resp = await fetch("/config", { cache: "no-store" });
  const cfg = await resp.json();

  if (!cfg.API_BASE_URL) {
    const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (isLocal) cfg.API_BASE_URL = "http://127.0.0.1:8000";
  }

  window.__APP_CONFIG__ = cfg;
  return cfg;
};
