// frontend/static/config.js
window.__APP_CONFIG__ = null;

window.loadAppConfig = async function () {
  if (window.__APP_CONFIG__) return window.__APP_CONFIG__;

  const resp = await fetch("/config");
  const cfg = await resp.json();

  // fallback for local dev
  if (!cfg.API_BASE_URL) cfg.API_BASE_URL = "http://127.0.0.1:8000";

  window.__APP_CONFIG__ = cfg;
  return cfg;
};
