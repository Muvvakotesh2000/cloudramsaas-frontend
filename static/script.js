// frontend/static/script.js
console.log("✅ script.js loaded");

// ==================================================
// BASE URLS
// ==================================================
async function apiBase() {
  const cfg = await window.loadAppConfig();
  return (cfg.API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
}
function agentBase() { return "http://127.0.0.1:7071"; }

const AGENT_ZIP_URL =
  "https://github.com/Muvvakotesh2000/cloudramsaas-LocalAgent/archive/refs/heads/main.zip";

// ==================================================
// Helpers
// ==================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isAbortError(e) { return e?.name === "AbortError" || String(e).toLowerCase().includes("aborted"); }
function isTimeoutMsg(e) { return String(e?.message || e || "").toLowerCase().includes("timed out"); }

async function withTimeout(promise, ms, msg) {
  let t;
  const tout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg || `Timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([promise, tout]); } finally { clearTimeout(t); }
}

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

async function fetchJsonWithTimeout(url, opts = {}, ms = 30000) {
  try {
    const r = await fetchWithTimeout(url, opts, ms);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) {
      const detail = data?.detail ?? data?.error ?? data?.message ?? data?.raw ?? `HTTP ${r.status}`;
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return data;
  } catch (e) {
    if (isAbortError(e)) throw new Error(`Request timed out after ${Math.round(ms / 1000)}s.`);
    throw e;
  }
}

async function isAgentOnline() {
  try {
    const r = await fetchWithTimeout(`${agentBase()}/health`, { cache: "no-store" }, 2500);
    return r.ok;
  } catch { return false; }
}

async function copyTextReliable(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "clipboard" };
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:-9999px";
    document.body.appendChild(ta); ta.focus(); ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return { ok: true, method: "execCommand" };
  } catch {}
  try { window.prompt("Copy this command:", text); return { ok: true, method: "prompt" }; } catch {}
  return { ok: false, method: "none" };
}

// ==================================================
// Supabase
// ==================================================
async function getSb() {
  if (window._sbClient) return window._sbClient;
  const cfg = await window.loadAppConfig();
  if (!window.supabase?.createClient) { console.error("❌ Supabase SDK not loaded"); return null; }
  window._sbClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  return window._sbClient;
}

async function getAccessTokenResilient() {
  try {
    const sb = await getSb();
    if (sb) {
      for (let i = 1; i <= 5; i++) {
        try {
          const { data } = await withTimeout(sb.auth.getSession(), 12000, "getSession timed out");
          const token = data?.session?.access_token;
          if (token) { localStorage.setItem("sb_access_token", token); return token; }
        } catch { await sleep(600 * i); }
      }
    }
  } catch {}
  const ls = localStorage.getItem("sb_access_token");
  if (ls) return ls;
  return "";
}

// ==================================================
// UI helpers
// ==================================================
function setGateStatus(ok, msg) {
  const el  = document.getElementById("allocate-agent-status");
  const btn = document.getElementById("allocate-btn");
  if (el) { el.textContent = msg || ""; el.style.color = ok ? "lightgreen" : "crimson"; }
  if (btn) btn.disabled = !ok;
}

function setAllocateBusy(busy, msg = "") {
  const loadingText  = document.getElementById("loading-text");
  const statusMsg    = document.getElementById("status-message");
  const btn          = document.getElementById("allocate-btn");

  if (btn) btn.disabled = !!busy;
  if (loadingText) { loadingText.style.display = busy ? "block" : "none"; if (msg) loadingText.textContent = msg; }
  if (statusMsg && msg) { statusMsg.style.color = "white"; statusMsg.textContent = msg; }
}

async function updateAllocateGate() {
  const ok  = await isAgentOnline();
  const btn = document.getElementById("allocate-btn");
  if (ok) setGateStatus(true, "✅ Local Agent is running. Click Allocate to continue.");
  else    setGateStatus(false, "❌ Local Agent is NOT running. Install & Run it, then click Retry Agent.");
  if (btn) btn.style.display = "inline-block";
}

let _agentPollTimer = null;
function startAgentGatePolling() {
  if (_agentPollTimer) return;
  _agentPollTimer = setInterval(async () => {
    if (window.location.pathname.toLowerCase() !== "/allocate") return;
    const ok  = await isAgentOnline();
    const btn = document.getElementById("allocate-btn");
    if (ok) {
      setGateStatus(true, "✅ Local Agent is running. Click Allocate to continue.");
      // ✅ Re-bind in case the page DOM shifted while polling
      attachAllocateBtn();
      clearInterval(_agentPollTimer);
      _agentPollTimer = null;
    }
  }, 1200);
}

// ==================================================
// Install/Run commands
// ==================================================
function buildInstallCommand() {
  return [
    '$ErrorActionPreference="Stop"',
    '$dest="C:\\CloudRAMS\\LocalAgent"',
    'New-Item -ItemType Directory -Force -Path $dest | Out-Null',
    'Write-Host "Downloading LocalAgent zip..."',
    `Invoke-WebRequest -Uri "${AGENT_ZIP_URL}" -OutFile "$env:TEMP\\LocalAgent.zip"`,
    'Write-Host "Extracting..."',
    'Expand-Archive -Path "$env:TEMP\\LocalAgent.zip" -DestinationPath $dest -Force',
    '$root=Get-ChildItem $dest | Where-Object {$_.PSIsContainer} | Select-Object -First 1',
    'if (-not $root) { throw "Could not find extracted folder." }',
    'Set-Location $root.FullName',
    'Write-Host "Creating venv..."', 'python -m venv .venv',
    'Write-Host "Installing requirements..."', '.\\.venv\\Scripts\\pip.exe install -r requirements.txt',
    'Write-Host "✅ Install complete."',
  ].join(" ; ");
}
function buildRunCommand() {
  return [
    '$ErrorActionPreference="Stop"',
    '$dest="C:\\CloudRAMS\\LocalAgent"',
    '$root=Get-ChildItem $dest | Where-Object {$_.PSIsContainer} | Select-Object -First 1',
    'if (-not $root) { throw "Agent folder not found. Run install first." }',
    'Set-Location $root.FullName',
    '.\\.venv\\Scripts\\python.exe agent_main.py',
  ].join(" ; ");
}
function buildInstallAndRunCommand() { return `${buildInstallCommand()} ; ${buildRunCommand()}`; }

// ==================================================
// SPA Navigation
// ==================================================
function navigate(page, pushState = true) {
  ["login-page","register-page","home-page","allocate-page"].forEach(p => {
    const el = document.getElementById(p);
    if (el) el.style.display = "none";
  });

  const target = document.getElementById(`${page}-page`);
  if (target) target.style.display = "block";

  const nav = document.getElementById("nav");
  if (nav) nav.style.display = (page === "login" || page === "register") ? "none" : "block";

  if (pushState) {
    const paths = { login:"/login", register:"/register", home:"/", allocate:"/allocate" };
    window.history.pushState({}, "", paths[page] || "/");
  }

  if (page === "allocate") {
    setTimeout(async () => {
      attachAllocateBtn();       // ✅ always attach fresh
      await updateAllocateGate();
      startAgentGatePolling();
      const sm = document.getElementById("status-message");
      if (sm) { sm.style.color = "white"; sm.textContent = "Click Allocate to check existing VM or create a new VM."; }
    }, 0);
  }
}

function routeByPath() {
  const p = window.location.pathname.toLowerCase();
  if (p === "/register") return navigate("register", false);
  if (p === "/login")    return navigate("login",    false);
  if (p === "/allocate") return navigate("allocate", false);
  if (p === "/")         return navigate("home",     false);
  return navigate("login", false);
}
window.navigate = navigate;

// ==================================================
// ✅ Allocate button — reliable single attach
// Uses a WeakMap flag instead of dataset so it survives cloneNode scenarios
// and works even if the element is the same node re-shown.
// ==================================================
const _btnBound = new WeakSet();

function attachAllocateBtn() {
  const btn = document.getElementById("allocate-btn");
  if (!btn) { console.warn("attachAllocateBtn: #allocate-btn not in DOM"); return; }
  if (_btnBound.has(btn)) { console.log("allocate-btn already bound, skipping"); return; }

  _btnBound.add(btn);
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await allocateClickFlow();
  });
  console.log("✅ allocate-btn bound");
}

// Delegation fallback — catches clicks even if attachAllocateBtn missed
let _delegateBound = false;
function bindAllocateDelegationFallback() {
  if (_delegateBound) return;
  _delegateBound = true;
  document.addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("#allocate-btn");
    if (!btn || btn.disabled) return;
    // If already properly bound, the above listener fires first.
    // This only catches cases where binding was missed entirely.
    if (!_btnBound.has(btn)) {
      e.preventDefault(); e.stopPropagation();
      console.log("🛟 Delegation fallback caught #allocate-btn click");
      await allocateClickFlow();
    }
  }, true);
}

// Expose for inline onclick fallback (legacy safety)
window.allocateClickFlow = allocateClickFlow;
// Expose attach so polling can re-call it
window.attachAllocateBtn = attachAllocateBtn;

// ==================================================
// Session-aware UI
// ==================================================
async function refreshUIForSession() {
  const sb = await getSb();
  if (!sb) return;

  const token = await getAccessTokenResilient();
  if (!token) {
    localStorage.removeItem("sb_access_token");
    const p = window.location.pathname.toLowerCase();
    if (p !== "/login" && p !== "/register") navigate("login", false);
    return;
  }
  localStorage.setItem("sb_access_token", token);

  const path = window.location.pathname.toLowerCase();
  if      (path === "/allocate") navigate("allocate", false);
  else if (path === "/")         navigate("home",     false);
  else if (path === "/login")    navigate("login",    false);
  else if (path === "/register") navigate("register", false);
  else                           navigate("home",     false);

  try {
    const { data: { user } } = await withTimeout(sb.auth.getUser(), 10000, "getUser timed out");
    const el = document.getElementById("user-email");
    if (el && user?.email) el.textContent = `Logged in as: ${user.email}`;
  } catch {}
}

// ==================================================
// Auth functions
// ==================================================
async function registerUser() {
  const sb = await getSb();
  const errorEl = document.getElementById("register-error");
  if (errorEl) errorEl.textContent = "";
  if (!sb) { if (errorEl) errorEl.textContent = "Supabase not initialized."; return; }

  const firstName = document.getElementById("register-firstname").value.trim();
  const lastName  = document.getElementById("register-lastname").value.trim();
  const phone     = document.getElementById("register-phone").value.trim();
  const email     = document.getElementById("register-email").value.trim();
  const password  = document.getElementById("register-password").value;

  const { error } = await sb.auth.signUp({ email, password,
    options: { data: { first_name: firstName, last_name: lastName, phone },
               emailRedirectTo: window.location.origin + "/callback" } });
  if (error) { if (errorEl) errorEl.textContent = error.message; return; }
  alert("Registration successful! Check your email to confirm.");
  navigate("login");
}

async function login() {
  const sb = await getSb();
  const errorEl = document.getElementById("login-error");
  if (errorEl) errorEl.textContent = "";
  if (!sb) { if (errorEl) errorEl.textContent = "Supabase not initialized."; return; }

  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { if (errorEl) errorEl.textContent = error.message; return; }
    if (data?.session?.access_token) localStorage.setItem("sb_access_token", data.session.access_token);
    navigate(window.location.pathname.toLowerCase() === "/allocate" ? "allocate" : "home");
  } catch { if (errorEl) errorEl.textContent = "Unexpected login error. Check console."; }
}

async function loginWithGoogle() {
  const sb = await getSb();
  const errorEl = document.getElementById("login-error");
  if (errorEl) errorEl.textContent = "";
  if (!sb) { if (errorEl) errorEl.textContent = "Supabase not initialized."; return; }
  const { error } = await sb.auth.signInWithOAuth({ provider: "google",
    options: { redirectTo: window.location.origin + "/callback" } });
  if (error && errorEl) errorEl.textContent = error.message;
}

async function logout() {
  const sb = await getSb();
  if (sb) await sb.auth.signOut();
  localStorage.removeItem("sb_access_token");
  localStorage.removeItem("vm_id");
  localStorage.removeItem("vm_ip");
  navigate("login");
}

window.registerUser   = registerUser;
window.login          = login;
window.loginWithGoogle = loginWithGoogle;
window.logout         = logout;

// ==================================================
// VM polling
// ==================================================
async function pollVmUntilRunning(accessToken, { maxMinutes = 15, intervalMs = 5000, requestTimeoutMs = 90000, statusPrefix = "⏳" } = {}) {
  const base   = await apiBase();
  const url    = `${base}/my_vm`;
  const headers = { "Authorization": `Bearer ${accessToken}` };
  const endAt  = Date.now() + maxMinutes * 60 * 1000;
  let attempt  = 0;

  while (Date.now() < endAt) {
    attempt++;
    let info = null;
    try {
      info = await fetchJsonWithTimeout(url, { headers }, requestTimeoutMs);
    } catch (e) {
      if (isTimeoutMsg(e)) {
        const sm = document.getElementById("status-message");
        if (sm) { sm.style.color = "white"; sm.textContent = `${statusPrefix} Network slow. Retrying... (attempt ${attempt})`; }
        await sleep(intervalMs); continue;
      }
      throw e;
    }

    if (info?.vm_id) localStorage.setItem("vm_id", info.vm_id);
    if (info?.ip)    localStorage.setItem("vm_ip", info.ip);

    const sm = document.getElementById("status-message");
    if (sm) { sm.style.color = "white"; sm.textContent = `${statusPrefix} state=${info.state || "unknown"} (attempt ${attempt})`; }

    if (!info.exists) throw new Error("No VM found. Click Allocate again.");
    if (info.state === "running" && info.ip) return info;

    await sleep(intervalMs);
  }
  throw new Error("VM is taking longer than expected. Please wait and try again.");
}

// ==================================================
// Stopped VM choices (Allocate page)
// ==================================================
function renderStoppedVmChoices(vmInfo, accessToken) {
  const statusMessage = document.getElementById("status-message");
  const allocateBtn   = document.getElementById("allocate-btn");
  if (!statusMessage) return;
  if (allocateBtn) allocateBtn.style.display = "none";

  statusMessage.style.color = "white";
  statusMessage.innerHTML = `
    <div style="margin-top:10px;">
      <div style="font-weight:bold;">🟡 Existing VM is STOPPED.</div>
      <div style="margin-top:6px;">VM ID: ${vmInfo.vm_id}</div>
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        <button id="resume-vm-btn" type="button" style="padding:10px 14px;border-radius:6px;border:none;cursor:pointer;background:#00c4cc;color:white;">
          Resume stopped instance
        </button>
        <button id="new-vm-btn" type="button" style="padding:10px 14px;border-radius:6px;border:none;cursor:pointer;background:#ff5b5b;color:white;">
          Create new instance (terminate old)
        </button>
      </div>
      <div style="margin-top:10px;font-size:13px;opacity:0.95;">
        Creating a new instance will terminate the old one — data will be lost permanently.
      </div>
    </div>`;

  // ✅ Bind immediately after injecting HTML — no cloning needed
  document.getElementById("resume-vm-btn")?.addEventListener("click", async () => {
    try {
      setAllocateBusy(true, "Requesting resume (can take several minutes)...");
      const base = await apiBase();
      try {
        await fetchJsonWithTimeout(`${base}/start_vm`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
          body: JSON.stringify({ vm_id: vmInfo.vm_id })
        }, 25000);
      } catch (e) {
        if (!isTimeoutMsg(e)) throw e;
        const sm = document.getElementById("status-message");
        if (sm) { sm.style.color = "white"; sm.textContent = "⏳ Resume requested. Waiting for VM to become RUNNING..."; }
      }
      await pollVmUntilRunning(accessToken, { maxMinutes: 15, intervalMs: 5000, requestTimeoutMs: 90000, statusPrefix: "⏳ Resuming:" });
      window.location.href = "/status";
    } catch (e) {
      const sm = document.getElementById("status-message");
      if (sm) { sm.style.color = "crimson"; sm.textContent = `❌ Resume failed: ${e.message || e}`; }
    } finally {
      setAllocateBusy(false);
      await updateAllocateGate();
    }
  });

  document.getElementById("new-vm-btn")?.addEventListener("click", async () => {
    if (!confirm("Creating a new instance will TERMINATE your old instance and ALL data will be lost permanently. Continue?")) return;
    try {
      setAllocateBusy(true, "Terminating old VM...");
      const base = await apiBase();
      await fetchJsonWithTimeout(`${base}/terminate_vm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
        body: JSON.stringify({ vm_id: vmInfo.vm_id })
      }, 90000);
      if (allocateBtn) allocateBtn.style.display = "inline-block";
      statusMessage.style.color = "white";
      statusMessage.textContent = "✅ Old VM terminated. Click Allocate to create a new instance.";
    } catch (e) {
      statusMessage.style.color = "crimson";
      statusMessage.textContent = `❌ Could not terminate: ${e.message || e}`;
    } finally {
      setAllocateBusy(false);
      await updateAllocateGate();
    }
  });
}

// ==================================================
// Allocate Click Flow
// ==================================================
async function allocateClickFlow() {
  console.log("✅ allocateClickFlow started");
  const statusMessage = document.getElementById("status-message");
  const ramSize = parseInt(document.getElementById("ram")?.value || "1", 10);

  try {
    if (statusMessage) { statusMessage.style.color = "white"; statusMessage.textContent = ""; }

    const agentOk = await isAgentOnline();
    if (!agentOk) {
      setGateStatus(false, "❌ Local Agent is NOT running. Install & Run it, then click Retry Agent.");
      if (statusMessage) { statusMessage.style.color = "crimson"; statusMessage.textContent = "Start Local Agent first."; }
      startAgentGatePolling();
      return;
    }

    const accessToken = await getAccessTokenResilient();
    if (!accessToken) {
      if (statusMessage) { statusMessage.style.color = "crimson"; statusMessage.textContent = "❌ Session not ready. Please login again."; }
      navigate("login"); return;
    }
    localStorage.setItem("sb_access_token", accessToken);

    setAllocateBusy(true, "Checking existing VM...");

    const base = await apiBase();
    const info = await fetchJsonWithTimeout(`${base}/my_vm`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    }, 90000);

    if (info?.vm_id) localStorage.setItem("vm_id", info.vm_id);
    if (info?.ip)    localStorage.setItem("vm_ip", info.ip);

    if (info?.exists) {
      if (info.state === "running" && info.ip) {
        if (statusMessage) { statusMessage.style.color = "lightgreen"; statusMessage.textContent = `✅ VM already RUNNING (${info.ip}). Opening dashboard...`; }
        await sleep(350); window.location.href = "/status"; return;
      }
      if (info.state === "stopped" || info.state === "stopping") {
        setAllocateBusy(false);
        renderStoppedVmChoices(info, accessToken);
        return;
      }
      if (statusMessage) { statusMessage.style.color = "white"; statusMessage.textContent = `⏳ VM in state: ${info.state}. Please wait and try again.`; }
      return;
    }

    setAllocateBusy(true, "Allocating new VM (can take 10–15 min)...");
    try {
      await fetchJsonWithTimeout(`${base}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
        body: JSON.stringify({ ram_size: ramSize })
      }, 25000);
    } catch (e) {
      if (!isTimeoutMsg(e)) throw e;
      if (statusMessage) { statusMessage.style.color = "white"; statusMessage.textContent = "⏳ Allocation requested. Waiting for VM..."; }
    }

    await pollVmUntilRunning(accessToken, { maxMinutes: 15, intervalMs: 5000, requestTimeoutMs: 90000, statusPrefix: "⏳ Allocating:" });

    if (statusMessage) { statusMessage.style.color = "lightgreen"; statusMessage.textContent = "✅ VM is ready. Opening dashboard..."; }
    await sleep(350);
    window.location.href = "/status";
  } catch (err) {
    console.error("allocateClickFlow error:", err);
    if (statusMessage) { statusMessage.style.color = "crimson"; statusMessage.textContent = `❌ ${err.message || err}`; }
  } finally {
    setAllocateBusy(false);
    await updateAllocateGate();
  }
}

window.allocateClickFlow = allocateClickFlow;

// ==================================================
// INIT
// ==================================================
document.addEventListener("DOMContentLoaded", async () => {
  routeByPath();
  bindAllocateDelegationFallback();

  const sb = await getSb();
  if (!sb) return;

  await refreshUIForSession();

  // ✅ Attach after session is resolved (DOM is stable at this point)
  attachAllocateBtn();

  if (window.location.pathname.toLowerCase() === "/allocate") {
    await updateAllocateGate();
    startAgentGatePolling();
  }

  sb.auth.onAuthStateChange(async () => {
    await refreshUIForSession();
    attachAllocateBtn(); // re-attach in case page switched
    if (window.location.pathname.toLowerCase() === "/allocate") {
      await updateAllocateGate();
      startAgentGatePolling();
    }
  });

  const retry = document.getElementById("allocate-agent-retry");
  if (retry) {
    retry.addEventListener("click", async () => {
      await updateAllocateGate();
      startAgentGatePolling();
    });
  }

  const installRun = document.getElementById("allocate-install-run");
  if (installRun) {
    installRun.addEventListener("click", async () => {
      const cmd = buildInstallAndRunCommand();
      const res = await copyTextReliable(cmd);
      setGateStatus(false,
        res.ok
          ? `📋 Command copied (${res.method}). Paste into PowerShell, then click Retry Agent.`
          : "❌ Could not copy. Open console for the command."
      );
      if (!res.ok) console.log("INSTALL+RUN CMD:\n", cmd);
    });
  }

  window.addEventListener("popstate", () => routeByPath());
});