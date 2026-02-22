// frontend/static/script.js
// ✅ FIXES:
//   - renderStoppedVmChoices: always fetches fresh token (not stale passed-in token)
//   - Resume/Terminate buttons: capturedVmId in closure, re-enable on error
//   - Supabase getSession() timeout: 30s + localStorage fallback
//   - Allocate buttons via event delegation

console.log("✅ script.js loaded");

// ==================================================
// ✅ BASE URLS
// ==================================================
async function apiBase() {
  const cfg = await window.loadAppConfig();
  return (cfg.API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
}

function agentBase() {
  return "http://127.0.0.1:7071";
}

const AGENT_ZIP_URL =
  "https://github.com/Muvvakotesh2000/cloudramsaas-LocalAgent/archive/refs/heads/main.zip";

// ==================================================
// ✅ Helpers
// ==================================================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAbortError(e) {
  return e?.name === "AbortError" || String(e).toLowerCase().includes("aborted");
}

function isTimeoutMessage(e) {
  return String(e?.message || e || "").toLowerCase().includes("timed out");
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = 30000) {
  try {
    const r = await fetchWithTimeout(url, opts, timeoutMs);
    const text = await r.text();

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      const detail = data?.detail ?? data?.error ?? data?.message ?? data?.raw ?? `HTTP ${r.status}`;
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return data;
  } catch (e) {
    if (isAbortError(e)) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw e;
  }
}

async function withTimeout(promise, timeoutMs, label = "operation") {
  let t;
  const timeoutPromise = new Promise((_, reject) => {
    t = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(t);
  }
}

async function paint() {
  await new Promise((r) => setTimeout(r, 0));
}

async function isAgentOnline() {
  try {
    const r = await fetchWithTimeout(`${agentBase()}/health`, { cache: "no-store" }, 2500);
    return r.ok;
  } catch (e) {
    console.warn("isAgentOnline failed:", e);
    return false;
  }
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
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return { ok: true, method: "execCommand" };
  } catch {}

  try {
    window.prompt("Copy this command:", text);
    return { ok: true, method: "prompt" };
  } catch {
    return { ok: false, method: "none" };
  }
}

// ==================================================
// ✅ UI helpers (Allocate page)
// ==================================================
function setGateStatus(ok, msg) {
  const statusEl = document.getElementById("allocate-agent-status");
  const allocateBtn = document.getElementById("allocate-btn");

  if (statusEl) {
    statusEl.textContent = msg || "";
    statusEl.style.color = ok ? "lightgreen" : "crimson";
  }
  if (allocateBtn) allocateBtn.disabled = !ok;
}

function setAllocateBusy(isBusy, msg = "") {
  const loadingText = document.getElementById("loading-text");
  const statusMessage = document.getElementById("status-message");
  const allocateBtn = document.getElementById("allocate-btn");

  if (allocateBtn) allocateBtn.disabled = !!isBusy;

  if (loadingText) {
    loadingText.style.display = isBusy ? "block" : "none";
    if (msg) loadingText.textContent = msg;
  }

  if (statusMessage && msg) {
    statusMessage.style.color = "white";
    statusMessage.textContent = msg;
  }
}

async function updateAllocateGate() {
  const ok = await isAgentOnline();
  if (ok) setGateStatus(true, "✅ Local Agent is running. Click Allocate to continue.");
  else setGateStatus(false, "❌ Local Agent is NOT running. Click Install & Run Agent, then Retry Agent.");

  const allocateBtn = document.getElementById("allocate-btn");
  if (allocateBtn) allocateBtn.style.display = "inline-block";
}

let _agentPollTimer = null;
function startAgentGatePolling() {
  if (_agentPollTimer) return;
  _agentPollTimer = setInterval(async () => {
    if (window.location.pathname.toLowerCase() !== "/allocate") return;

    const ok = await isAgentOnline();
    const allocateBtn = document.getElementById("allocate-btn");

    if (ok) {
      if (allocateBtn && allocateBtn.disabled && document.getElementById("loading-text")?.style.display !== "block") {
        setGateStatus(true, "✅ Local Agent is running. Click Allocate to continue.");
      }
      clearInterval(_agentPollTimer);
      _agentPollTimer = null;
    }
  }, 1200);
}

// ==================================================
// ✅ Local Agent install/run commands
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
    'if (-not $root) { throw "Could not find extracted folder inside destination." }',
    'Set-Location $root.FullName',
    'Write-Host "Creating venv..."',
    'python -m venv .venv',
    'Write-Host "Installing requirements..."',
    '.\\.venv\\Scripts\\pip.exe install -r requirements.txt',
    'Write-Host "✅ Install complete. Next: run the agent."',
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

function buildInstallAndRunCommand() {
  return `${buildInstallCommand()} ; ${buildRunCommand()}`;
}

// ==================================================
// ✅ SPA Navigation
// ==================================================
function navigate(page, pushState = true) {
  const pages = ["login-page", "register-page", "home-page", "allocate-page"];

  pages.forEach((p) => {
    const el = document.getElementById(p);
    if (el) el.style.display = "none";
  });

  const target = document.getElementById(`${page}-page`);
  if (target) target.style.display = "block";

  const nav = document.getElementById("nav");
  if (nav) nav.style.display = (page === "login" || page === "register") ? "none" : "block";

  if (pushState) {
    const newPath =
      page === "login" ? "/login" :
      page === "register" ? "/register" :
      page === "home" ? "/" :
      page === "allocate" ? "/allocate" : "/";
    window.history.pushState({}, "", newPath);
  }

  if (page === "allocate") {
    setTimeout(async () => {
      await updateAllocateGate();
      startAgentGatePolling();

      const statusMessage = document.getElementById("status-message");
      if (statusMessage) {
        statusMessage.style.color = "white";
        statusMessage.textContent =
          "Click Allocate to check existing VM (running/stopped) or create a new VM.";
      }
    }, 0);
  }
}

function routeByPath() {
  const path = window.location.pathname.toLowerCase();
  if (path === "/register") return navigate("register", false);
  if (path === "/login") return navigate("login", false);
  if (path === "/allocate") return navigate("allocate", false);
  if (path === "/") return navigate("home", false);
  return navigate("login", false);
}

window.navigate = navigate;

// ==================================================
// ✅ Supabase
// ==================================================
async function getSb() {
  if (window._sbClient) return window._sbClient;
  const cfg = await window.loadAppConfig();
  if (!window.supabase || !window.supabase.createClient) {
    console.error("❌ Supabase SDK not loaded. Check index.html script order.");
    return null;
  }
  window._sbClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  return window._sbClient;
}

// ✅ Always gets freshest possible token — tries Supabase first, falls back to localStorage
async function getFreshAccessToken() {
  try {
    const sb = await getSb();
    if (sb) {
      const { data: { session } } = await withTimeout(sb.auth.getSession(), 30000, "getSession");
      if (session?.access_token) {
        localStorage.setItem("sb_access_token", session.access_token);
        return session.access_token;
      }
    }
  } catch (e) {
    console.warn("getFreshAccessToken: getSession failed, using localStorage fallback:", e);
  }
  const stored = localStorage.getItem("sb_access_token");
  if (stored) return stored;
  throw new Error("No auth token found. Please log out and log back in.");
}

async function refreshUIForSession() {
  const sb = await getSb();
  if (!sb) return;

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    localStorage.removeItem("sb_access_token");
    const p = window.location.pathname.toLowerCase();
    if (p !== "/login" && p !== "/register") navigate("login", false);
    return;
  }

  localStorage.setItem("sb_access_token", session.access_token);

  const path = window.location.pathname.toLowerCase();
  if (path === "/allocate") navigate("allocate", false);
  else if (path === "/") navigate("home", false);
  else if (path === "/login") navigate("login", false);
  else if (path === "/register") navigate("register", false);
  else navigate("home", false);

  const userEmailEl = document.getElementById("user-email");
  if (userEmailEl) userEmailEl.textContent = `Logged in as: ${session.user.email}`;
}

// ==================================================
// ✅ Auth functions (GLOBAL)
// ==================================================
async function registerUser() {
  const sb = await getSb();
  const errorEl = document.getElementById("register-error");
  if (errorEl) errorEl.textContent = "";
  if (!sb) {
    if (errorEl) errorEl.textContent = "Supabase not initialized.";
    return;
  }

  const firstName = document.getElementById("register-firstname").value.trim();
  const lastName = document.getElementById("register-lastname").value.trim();
  const phone = document.getElementById("register-phone").value.trim();
  const email = document.getElementById("register-email").value.trim();
  const password = document.getElementById("register-password").value;

  const { error } = await sb.auth.signUp({
    email,
    password,
    options: {
      data: { first_name: firstName, last_name: lastName, phone },
      emailRedirectTo: window.location.origin + "/callback",
    },
  });

  if (error) {
    if (errorEl) errorEl.textContent = error.message;
    return;
  }

  alert("Registration successful! Check your email to confirm (if enabled).");
  navigate("login");
}

async function login() {
  const sb = await getSb();
  const errorEl = document.getElementById("login-error");
  if (errorEl) errorEl.textContent = "";
  if (!sb) {
    if (errorEl) errorEl.textContent = "Supabase not initialized.";
    return;
  }

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      if (errorEl) errorEl.textContent = error.message;
      return;
    }
    if (data?.session?.access_token) localStorage.setItem("sb_access_token", data.session.access_token);

    const path = window.location.pathname.toLowerCase();
    if (path === "/allocate") navigate("allocate");
    else navigate("home");
  } catch (e) {
    if (errorEl) errorEl.textContent = "Unexpected login error. Check console.";
  }
}

async function loginWithGoogle() {
  const sb = await getSb();
  const errorEl = document.getElementById("login-error");
  if (errorEl) errorEl.textContent = "";
  if (!sb) {
    if (errorEl) errorEl.textContent = "Supabase not initialized.";
    return;
  }

  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + "/callback" },
  });

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

window.registerUser = registerUser;
window.login = login;
window.loginWithGoogle = loginWithGoogle;
window.logout = logout;

// ==================================================
// ✅ VM polling (timeout-tolerant)
// ==================================================
async function pollVmUntilRunning(accessToken, {
  maxMinutes = 15,
  intervalMs = 5000,
  requestTimeoutMs = 90000,
  statusPrefix = "⏳"
} = {}) {
  const base = await apiBase();
  const url = `${base}/my_vm`;
  const headers = { "Authorization": `Bearer ${accessToken}` };

  const endAt = Date.now() + maxMinutes * 60 * 1000;
  let attempt = 0;

  while (Date.now() < endAt) {
    attempt += 1;

    let info = null;
    try {
      info = await fetchJsonWithTimeout(url, { headers }, requestTimeoutMs);
    } catch (e) {
      if (isTimeoutMessage(e)) {
        const sm = document.getElementById("status-message");
        if (sm) {
          sm.style.color = "white";
          sm.textContent = `${statusPrefix} Network slow / backend cold start. Retrying... (attempt ${attempt})`;
        }
        await sleep(intervalMs);
        continue;
      }
      throw e;
    }

    if (info?.vm_id) localStorage.setItem("vm_id", info.vm_id);
    if (info?.ip) localStorage.setItem("vm_ip", info.ip);

    const sm = document.getElementById("status-message");
    if (sm) {
      sm.style.color = "white";
      sm.textContent = `${statusPrefix} Waiting... state=${info.state || "unknown"} (attempt ${attempt})`;
    }

    if (!info.exists) throw new Error("No VM found while waiting. Please click Allocate again.");
    if (info.state === "running" && info.ip) return info;

    await sleep(intervalMs);
  }

  throw new Error("VM is taking longer than expected. Please wait and try again.");
}

// ==================================================
// ✅ Existing VM UI (stopped) — FIXED
// ==================================================
function renderStoppedVmChoices(vmInfo, _accessToken) {
  // NOTE: _accessToken param is kept for API compat but we always fetch fresh below
  const statusMessage = document.getElementById("status-message");
  const allocateBtn = document.getElementById("allocate-btn");
  if (!statusMessage) return;

  if (allocateBtn) allocateBtn.style.display = "none";

  statusMessage.style.color = "white";
  statusMessage.innerHTML = `
    <div style="margin-top:10px;">
      <div style="font-weight:bold;">🟡 Existing VM is STOPPED.</div>
      <div style="margin-top:6px; font-size:13px; opacity:0.85;">VM ID: ${vmInfo.vm_id}</div>
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        <button id="resume-vm-btn" type="button"
          style="padding:10px 16px; border-radius:6px; border:none; cursor:pointer;
                 background:#00c4cc; color:white; font-size:15px;">
          ▶ Resume stopped instance
        </button>
        <button id="new-vm-btn" type="button"
          style="padding:10px 16px; border-radius:6px; border:none; cursor:pointer;
                 background:#ff5b5b; color:white; font-size:15px;">
          ✕ Create new instance (terminate old)
        </button>
      </div>
      <div style="margin-top:8px; font-size:12px; opacity:0.8;">
        Terminating the old instance will permanently delete all its data.
      </div>
      <p id="stopped-action-msg" style="margin-top:10px; font-weight:bold; min-height:1.4em;"></p>
    </div>
  `;

  // ✅ Capture vm_id in closure NOW — never read from global/localStorage at click time
  const capturedVmId = vmInfo.vm_id;

  function setMsg(text, color) {
    const el = document.getElementById("stopped-action-msg");
    if (el) { el.textContent = text; el.style.color = color || "white"; }
  }

  function disableBtns() {
    const r = document.getElementById("resume-vm-btn");
    const n = document.getElementById("new-vm-btn");
    if (r) r.disabled = true;
    if (n) n.disabled = true;
  }

  function enableBtns() {
    const r = document.getElementById("resume-vm-btn");
    const n = document.getElementById("new-vm-btn");
    if (r) r.disabled = false;
    if (n) n.disabled = false;
  }

  // ✅ Always fetch a fresh token at click time
  async function getFreshToken() {
    try {
      const sb = await getSb();
      if (sb) {
        const { data: { session } } = await sb.auth.getSession();
        if (session?.access_token) {
          localStorage.setItem("sb_access_token", session.access_token);
          return session.access_token;
        }
      }
    } catch (e) {
      console.warn("getSession failed, falling back to localStorage:", e);
    }
    const stored = localStorage.getItem("sb_access_token");
    if (stored) return stored;
    throw new Error("No auth token. Please log out and log back in.");
  }

  document.getElementById("resume-vm-btn").onclick = async function () {
    console.log("▶️ Resume clicked, vm_id:", capturedVmId);
    try {
      disableBtns();
      setMsg("⏳ Authenticating...");

      const token = await getFreshToken();
      console.log("▶️ Token obtained, calling start_vm...");
      setMsg("⏳ Requesting resume (may take a few minutes)...");

      const base = await apiBase();
      try {
        await fetchJsonWithTimeout(`${base}/start_vm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
          },
          body: JSON.stringify({ vm_id: capturedVmId }),
        }, 25000);
      } catch (e) {
        // A timeout here is normal — the VM starts async
        if (!isTimeoutMessage(e)) throw e;
        console.warn("start_vm timed out (expected for async start), continuing to poll...");
      }

      setMsg("⏳ Waiting for VM to become RUNNING...");
      await pollVmUntilRunning(token, {
        maxMinutes: 15,
        intervalMs: 5000,
        requestTimeoutMs: 90000,
        statusPrefix: "⏳ Resuming:",
      });

      setMsg("✅ VM is running! Opening dashboard...", "lightgreen");
      await sleep(600);
      window.location.href = "/status";

    } catch (e) {
      console.error("Resume failed:", e);
      setMsg(`❌ Resume failed: ${e.message || e}`, "crimson");
      enableBtns();
    }
  };

  document.getElementById("new-vm-btn").onclick = async function () {
    console.log("🗑️ Terminate clicked, vm_id:", capturedVmId);
    const ok = confirm(
      "Creating a new instance will TERMINATE your old instance — all data will be permanently lost. Continue?"
    );
    if (!ok) return;

    try {
      disableBtns();
      setMsg("⏳ Authenticating...");

      const token = await getFreshToken();
      console.log("🗑️ Token obtained, calling terminate_vm...");
      setMsg("⏳ Terminating old VM...");

      const base = await apiBase();
      await fetchJsonWithTimeout(`${base}/terminate_vm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ vm_id: capturedVmId }),
      }, 90000);

      localStorage.removeItem("vm_id");
      localStorage.removeItem("vm_ip");

      if (allocateBtn) allocateBtn.style.display = "inline-block";
      setMsg("✅ Old VM terminated. Click Allocate to create a new instance.", "lightgreen");

    } catch (e) {
      console.error("Terminate failed:", e);
      setMsg(`❌ Terminate failed: ${e.message || e}`, "crimson");
      enableBtns();
    }
  };

  console.log("✅ renderStoppedVmChoices: buttons bound for vm_id:", capturedVmId);
}

// ==================================================
// ✅ Allocate Click Flow
// ==================================================
async function getMyVmInfo(accessToken) {
  const base = await apiBase();
  return await fetchJsonWithTimeout(`${base}/my_vm`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  }, 90000);
}

let _allocateInFlight = false;

async function allocateClickFlow() {
  if (_allocateInFlight) {
    console.log("⛔ allocateClickFlow ignored (already running)");
    return;
  }
  _allocateInFlight = true;

  const statusMessage = document.getElementById("status-message");
  const step = async (msg) => {
    console.log(msg);
    if (statusMessage) {
      statusMessage.style.color = "white";
      statusMessage.textContent = msg;
    }
    await paint();
  };

  try {
    await step("✅ Click received. Starting allocation flow...");

    await step("🔎 Checking Local Agent health...");
    const agentOk = await withTimeout(isAgentOnline(), 4000, "Agent health check");
    if (!agentOk) {
      setGateStatus(false, "❌ Local Agent is NOT running. Click Install & Run Agent, then Retry Agent.");
      if (statusMessage) {
        statusMessage.style.color = "crimson";
        statusMessage.textContent = "Start Local Agent first. Allocate is disabled until Agent is running.";
      }
      startAgentGatePolling();
      return;
    }

    await step("🔑 Getting auth token...");
    const accessToken = await getFreshAccessToken();
    localStorage.setItem("sb_access_token", accessToken);

    setAllocateBusy(true, "Checking existing VM...");
    await step("🖥️ Checking existing VM (/my_vm)...");
    const info = await withTimeout(getMyVmInfo(accessToken), 95000, "/my_vm request");

    if (info?.vm_id) localStorage.setItem("vm_id", info.vm_id);
    if (info?.ip) localStorage.setItem("vm_ip", info.ip);

    if (info?.exists) {
      if (info.state === "running" && info.ip) {
        if (statusMessage) {
          statusMessage.style.color = "lightgreen";
          statusMessage.textContent = `✅ VM is already RUNNING (${info.ip}). Opening dashboard...`;
        }
        await sleep(350);
        window.location.href = "/status";
        return;
      }

      if (info.state === "stopped" || info.state === "stopping") {
        setAllocateBusy(false);
        renderStoppedVmChoices(info, accessToken);
        return;
      }

      if (statusMessage) {
        statusMessage.style.color = "white";
        statusMessage.textContent = `⏳ Existing VM found in state: ${info.state}. Please wait and try again.`;
      }
      return;
    }

    const ramSize = parseInt(document.getElementById("ram")?.value || "1", 10);
    setAllocateBusy(true, "Allocating new VM (can take 10–15 minutes)...");
    await step("🆕 No VM found. Requesting allocation...");

    const base = await apiBase();

    try {
      await fetchJsonWithTimeout(`${base}/allocate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ ram_size: ramSize }),
      }, 25000);
    } catch (e) {
      if (!isTimeoutMessage(e)) throw e;
      await step("⏳ Allocation requested. Polling until RUNNING + IP...");
    }

    await pollVmUntilRunning(accessToken, {
      maxMinutes: 15,
      intervalMs: 5000,
      requestTimeoutMs: 90000,
      statusPrefix: "⏳ Allocating:",
    });

    if (statusMessage) {
      statusMessage.style.color = "lightgreen";
      statusMessage.textContent = "✅ VM is ready. Opening dashboard...";
    }
    await sleep(350);
    window.location.href = "/status";
  } catch (err) {
    console.error("allocateClickFlow error:", err);
    if (statusMessage) {
      statusMessage.style.color = "crimson";
      statusMessage.textContent = `❌ ${err.message || err}`;
    }
  } finally {
    _allocateInFlight = false;
    setAllocateBusy(false);
    await updateAllocateGate();
  }
}

window.allocateClickFlow = allocateClickFlow;

// ==================================================
// ✅ Allocate click — event delegation
// ==================================================
let _allocDelegationBound = false;
function bindAllocateDelegation() {
  if (_allocDelegationBound) return;
  _allocDelegationBound = true;

  document.addEventListener("click", async (e) => {
    let el = e.target;
    if (el && el.nodeType === 3) el = el.parentElement;
    if (!(el instanceof Element)) return;

    const alloc = el.closest("#allocate-btn");
    if (!alloc) return;

    e.preventDefault();
    e.stopPropagation();

    if (alloc.disabled) return;

    console.log("✅ Allocate clicked");
    await allocateClickFlow();
  }, true);

  console.log("✅ Allocate delegation bound");
}

// ==================================================
// ✅ INIT
// ==================================================
document.addEventListener("DOMContentLoaded", async () => {
  routeByPath();
  bindAllocateDelegation();

  const sb = await getSb();
  if (!sb) return;

  await refreshUIForSession();

  if (window.location.pathname.toLowerCase() === "/allocate") {
    await updateAllocateGate();
    startAgentGatePolling();
  }

  sb.auth.onAuthStateChange(async () => {
    await refreshUIForSession();
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

      setGateStatus(
        false,
        res.ok
          ? `📋 Install & Run command copied (${res.method}). Paste into PowerShell, then click Retry Agent.`
          : "❌ Could not copy automatically. Open console for the command."
      );

      if (!res.ok) console.log("INSTALL+RUN CMD:\n", cmd);
    });
  }

  window.addEventListener("popstate", () => routeByPath());
});