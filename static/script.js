// frontend/static/script.js (FULL FILE — corrected + hardened for remote machines)
// ✅ No auto-redirect to dashboard just because Agent is running
// ✅ Allocate button enables reliably when Agent is running (with polling)
// ✅ Allocate click flow:
//    - checks existing VM (longer timeout for Render cold start)
//    - if RUNNING -> go dashboard
//    - if STOPPED -> show Resume / Create New buttons
//    - if no VM -> allocate new VM
// ✅ Install & Run button copy works reliably (clipboard + fallback)
// ✅ AbortError/Signal aborted -> friendly "Timed out" message instead of silent fail
// ✅ Avoid "double short timeouts" that cause guaranteed failures on cold start networks

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

async function fetchWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!r.ok) {
    const detail = data?.detail ?? data?.error ?? data?.message ?? data?.raw ?? `HTTP ${r.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = 25000) {
  try {
    const r = await fetchWithTimeout(url, opts, timeoutMs);
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!r.ok) {
      const detail = data?.detail ?? data?.error ?? data?.message ?? data?.raw ?? `HTTP ${r.status}`;
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return data;
  } catch (e) {
    if (isAbortError(e)) {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s. Try again (cold start / slow network).`
      );
    }
    throw e;
  }
}

async function isAgentOnline() {
  // fast health check
  try {
    const r = await fetchWithTimeout(`${agentBase()}/health`, { cache: "no-store" }, 2500);
    return r.ok;
  } catch {
    return false;
  }
}

// Clipboard copy that always gives user a way to copy
async function copyTextReliable(text) {
  // 1) modern clipboard
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "clipboard" };
    }
  } catch {}

  // 2) fallback textarea copy
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

  // 3) last resort prompt
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

// ✅ On /allocate page load or Retry click: enable Allocate if Agent online
async function updateAllocateGate() {
  const ok = await isAgentOnline();

  if (ok) {
    setGateStatus(true, "✅ Local Agent is running. Click Allocate to check existing VM / create one.");
  } else {
    setGateStatus(false, "❌ Local Agent is NOT running. Click Install & Run Agent, then Retry Agent.");
  }

  // ensure Allocate button is visible (in case stopped-vm UI hid it previously)
  const allocateBtn = document.getElementById("allocate-btn");
  if (allocateBtn) allocateBtn.style.display = "inline-block";
}

// ✅ Poll agent for a short period (helps on refresh/slow startup)
let _agentPollTimer = null;
function startAgentGatePolling() {
  if (_agentPollTimer) return;
  _agentPollTimer = setInterval(async () => {
    // only poll while on allocate page
    if (window.location.pathname.toLowerCase() !== "/allocate") return;

    const ok = await isAgentOnline();
    const allocateBtn = document.getElementById("allocate-btn");

    if (ok) {
      // Only flip to enabled if not busy
      if (allocateBtn && allocateBtn.disabled && document.getElementById("loading-text")?.style.display !== "block") {
        setGateStatus(true, "✅ Local Agent is running. Click Allocate to check existing VM / create one.");
      }
      // Once online, stop polling to reduce noise
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
  if (nav) nav.style.display = page === "login" || page === "register" ? "none" : "block";

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

// ✅ Do not force home on refresh; stay on current route
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
      console.error("Supabase login error:", error);
      if (errorEl) errorEl.textContent = `${error.message}`;
      return;
    }

    if (data?.session?.access_token) {
      localStorage.setItem("sb_access_token", data.session.access_token);
    }

    const path = window.location.pathname.toLowerCase();
    if (path === "/allocate") navigate("allocate");
    else navigate("home");
  } catch (e) {
    console.error("Unexpected login exception:", e);
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
// ✅ Existing VM UI (stopped)
// ==================================================
function renderStoppedVmChoices(vmInfo, accessToken) {
  const statusMessage = document.getElementById("status-message");
  const allocateBtn = document.getElementById("allocate-btn");
  if (!statusMessage) return;

  if (allocateBtn) allocateBtn.style.display = "none";

  statusMessage.style.color = "white";
  statusMessage.innerHTML = `
    <div style="margin-top:10px;">
      <div style="font-weight:bold;">🟡 Existing VM is STOPPED.</div>
      <div style="margin-top:6px;">VM ID: ${vmInfo.vm_id}</div>
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        <button id="resume-vm-btn" style="padding:10px 14px; border-radius:6px; border:none; cursor:pointer; background:#00c4cc; color:white;">
          Resume stopped instance
        </button>
        <button id="new-vm-btn" style="padding:10px 14px; border-radius:6px; border:none; cursor:pointer; background:#ff5b5b; color:white;">
          Create new instance (terminate old)
        </button>
      </div>
      <div style="margin-top:10px; font-size:13px; opacity:0.95;">
        Creating a new instance will terminate the old one and data will be lost permanently.
      </div>
    </div>
  `;

  const resumeBtn = document.getElementById("resume-vm-btn");
  const newBtn = document.getElementById("new-vm-btn");

  if (resumeBtn) {
    resumeBtn.addEventListener("click", async () => {
      try {
        setAllocateBusy(true, "Resuming VM...");

        const base = await apiBase();
        const data = await fetchJsonWithTimeout(`${base}/start_vm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ vm_id: vmInfo.vm_id }),
        }, 60000); // resume may take longer

        localStorage.setItem("vm_id", data.vm_id);
        if (data.ip) localStorage.setItem("vm_ip", data.ip);

        window.location.href = "/status";
      } catch (e) {
        const sm = document.getElementById("status-message");
        if (sm) {
          sm.style.color = "crimson";
          sm.textContent = `❌ Resume failed: ${e.message || e}`;
        }
      } finally {
        setAllocateBusy(false);
        await updateAllocateGate();
      }
    });
  }

  if (newBtn) {
    newBtn.addEventListener("click", async () => {
      const ok = confirm(
        "Creating a new instance will TERMINATE your old instance and ALL data on it will be lost permanently. Continue?"
      );
      if (!ok) return;

      try {
        setAllocateBusy(true, "Terminating old VM...");

        const base = await apiBase();
        await fetchJsonWithTimeout(`${base}/terminate_vm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ vm_id: vmInfo.vm_id }),
        }, 60000);

        if (allocateBtn) {
          allocateBtn.style.display = "inline-block";
        }

        statusMessage.style.color = "white";
        statusMessage.textContent = "✅ Old VM terminated. Click Allocate again to create a new instance.";
      } catch (e) {
        statusMessage.style.color = "crimson";
        statusMessage.textContent = `❌ Could not terminate old VM: ${e.message || e}`;
      } finally {
        setAllocateBusy(false);
        await updateAllocateGate();
      }
    });
  }
}

// ==================================================
// ✅ Allocate Click Flow (ONLY place we check existing VM)
// ==================================================
async function getMyVmInfo(accessToken) {
  const base = await apiBase();
  const url = `${base}/my_vm`;
  const opts = { headers: { "Authorization": `Bearer ${accessToken}` } };

  // Longer timeout for Render cold start / slow networks
  return await fetchJsonWithTimeout(url, opts, 25000);
}

async function allocateClickFlow() {
  const sb = await getSb();
  const statusMessage = document.getElementById("status-message");
  const allocateBtn = document.getElementById("allocate-btn");
  const ramSize = parseInt(document.getElementById("ram")?.value || "1", 10);

  try {
    if (statusMessage) {
      statusMessage.style.color = "white";
      statusMessage.textContent = "";
    }

    // Gate: agent must be running
    const agentOk = await isAgentOnline();
    if (!agentOk) {
      setGateStatus(false, "❌ Local Agent is NOT running. Click Install & Run Agent, then Retry Agent.");
      if (statusMessage) {
        statusMessage.style.color = "crimson";
        statusMessage.textContent = "Start Local Agent first. Allocate is disabled until Agent is running.";
      }
      startAgentGatePolling();
      return;
    }

    // Gate: logged in
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      navigate("login");
      return;
    }
    const accessToken = session.access_token;
    localStorage.setItem("sb_access_token", accessToken);

    // Step 1: check existing VM (running/stopped)
    setAllocateBusy(true, "Checking existing VM...");

    const info = await getMyVmInfo(accessToken);

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
        statusMessage.textContent = `⏳ Existing VM found in state: ${info.state}. Please wait and try again in a moment.`;
      }
      return;
    }

    // Step 2: no VM exists -> allocate new one
    setAllocateBusy(true, "No existing VM found. Allocating new VM (can take 10–15 minutes)...");

    const base = await apiBase();
    const data = await fetchJsonWithTimeout(`${base}/allocate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ ram_size: ramSize }),
    }, 90000); // allocate request can be slow on cold start

    if (data?.action_required) {
      setAllocateBusy(false);
      renderStoppedVmChoices({ vm_id: data.vm_id, state: data.state, ip: data.ip }, accessToken);
      return;
    }

    if (data?.vm_id) localStorage.setItem("vm_id", data.vm_id);
    if (data?.ip) localStorage.setItem("vm_ip", data.ip);

    if (statusMessage) {
      statusMessage.style.color = "lightgreen";
      statusMessage.textContent = "✅ VM allocated. Opening dashboard...";
    }
    await sleep(350);
    window.location.href = "/status";
  } catch (err) {
    if (statusMessage) {
      statusMessage.style.color = "crimson";
      statusMessage.textContent = `❌ ${err.message || err}`;
    }
    if (allocateBtn) allocateBtn.style.display = "inline-block";
  } finally {
    setAllocateBusy(false);
    await updateAllocateGate();
  }
}

// ==================================================
// ✅ INIT
// ==================================================
document.addEventListener("DOMContentLoaded", async () => {
  routeByPath();

  const sb = await getSb();
  if (!sb) return;

  await refreshUIForSession();

  // If user is on allocate after refresh, gate should be correct + poll for agent readiness
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

  // Allocate click
  const allocateBtn = document.getElementById("allocate-btn");
  if (allocateBtn) allocateBtn.addEventListener("click", allocateClickFlow);

  // Retry agent button: updates gate, no redirect
  const retry = document.getElementById("allocate-agent-retry");
  if (retry) {
    retry.addEventListener("click", async () => {
      await updateAllocateGate();
      startAgentGatePolling();
    });
  }

  // Install & Run: reliable copy
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
