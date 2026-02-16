// script.js (FULL FILE — updated to support Render Backend + Local Agent separation)
console.log("✅ script.js loaded");

// ==================================================
// ✅ BASE URLS
// ==================================================
async function apiBase() {
  const cfg = await window.loadAppConfig();
  // Render backend (FastAPI) base
  return (cfg.API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
}

// Local Agent base (runs on user's machine)
function agentBase() {
  return "http://127.0.0.1:7071";
}

const AGENT_ZIP_URL =
  "https://github.com/Muvvakotesh2000/cloudramsaas-LocalAgent/archive/refs/heads/main.zip";

// Small helper: fetch JSON + good errors
async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!r.ok) {
    const detail = data?.detail ?? data?.error ?? data?.message ?? data?.raw ?? `HTTP ${r.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

// Check if Local Agent is running
async function isAgentOnline() {
  try {
    const r = await fetch(`${agentBase()}/health`, { cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

// ==================================================
// ✅ ALLOCATE PAGE: Local Agent Gate + Install&Run (merged) + Retry
//   - (Removed) Download ZIP button (HTML removed)
//   - (Removed) Autostart button + command (HTML removed)
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
    // GitHub zip contains a root folder like cloudramsaas-LocalAgent-main
    '$root=Get-ChildItem $dest | Where-Object {$_.PSIsContainer} | Select-Object -First 1',
    'if (-not $root) { throw "Could not find extracted folder inside destination." }',
    'Set-Location $root.FullName',
    'Write-Host "Creating venv..."',
    'python -m venv .venv',
    'Write-Host "Installing requirements..."',
    '.\\.venv\\Scripts\\pip.exe install -r requirements.txt',
    'Write-Host "✅ Install complete. Next: run the agent."'
  ].join(" ; ");
}

function buildRunCommand() {
  return [
    '$ErrorActionPreference="Stop"',
    '$dest="C:\\CloudRAMS\\LocalAgent"',
    '$root=Get-ChildItem $dest | Where-Object {$_.PSIsContainer} | Select-Object -First 1',
    'if (-not $root) { throw "Agent folder not found. Run install first." }',
    'Set-Location $root.FullName',
    '.\\.venv\\Scripts\\python.exe agent_main.py'
  ].join(" ; ");
}

// ✅ New: merged "Install & Run Agent" command
function buildInstallAndRunCommand() {
  // Install then immediately run
  return `${buildInstallCommand()} ; ${buildRunCommand()}`;
}

function setAllocateGateUI({ ok, msg }) {
  const statusEl = document.getElementById("allocate-agent-status");
  const allocateBtn = document.getElementById("allocate-btn");

  if (statusEl) {
    statusEl.textContent = msg || "";
    statusEl.style.color = ok ? "lightgreen" : "crimson";
  }

  if (allocateBtn) allocateBtn.disabled = !ok;
}

async function enforceAgentGateOnAllocate() {
  const panel = document.getElementById("allocate-agent-panel");
  if (!panel) return;

  const ok = await isAgentOnline();
  if (ok) {
    setAllocateGateUI({
      ok: true,
      msg: "✅ Local Agent is running. Redirecting to status..."
    });

    // ✅ Requirement: only after agent is successfully running, redirect to status
    setTimeout(() => {
      window.location.href = "/status";
    }, 400);
  } else {
    setAllocateGateUI({
      ok: false,
      msg: "❌ Local Agent is NOT running. Click 'Install & Run Agent', run it in PowerShell, then click Retry."
    });
  }
}

// ==================================================
// ✅ NAVIGATION (DEFINE FIRST + GLOBAL)
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
      // Show agent status, but DO NOT redirect automatically here
      // Redirect should happen only after user clicks Retry (or if they land on /allocate directly below).
      const ok = await isAgentOnline();
      if (ok) {
        setAllocateGateUI({ ok: true, msg: "✅ Local Agent is running. Click Allocate to continue (or Retry to go to status)." });
      } else {
        setAllocateGateUI({ ok: false, msg: "❌ Local Agent is NOT running. Install & run it, then click Retry." });
      }

      await checkExistingVmAndRenderChoices(); // existing VM logic
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
// ✅ SUPABASE CONFIG
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

// ==================================================
// ✅ AUTH UI REFRESH
// ==================================================
async function refreshUIForSession() {
  const sb = await getSb();
  if (!sb) return;

  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    localStorage.removeItem("sb_access_token");
    navigate("login");
    return;
  }

  localStorage.setItem("sb_access_token", session.access_token);

  navigate("home");
  const userEmailEl = document.getElementById("user-email");
  if (userEmailEl) userEmailEl.textContent = `Logged in as: ${session.user.email}`;
}

// ==================================================
// ✅ AUTH FUNCTIONS (GLOBAL)
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

    await refreshUIForSession();
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
// ✅ Allocate page: Resume/New UI
// ==================================================
function setAllocateUIBusy(isBusy, msg = "") {
  const allocateBtn = document.getElementById("allocate-btn");
  const loadingText = document.getElementById("loading-text");
  const statusMessage = document.getElementById("status-message");

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

function renderStoppedVmChoices(vmInfo, accessToken) {
  const statusMessage = document.getElementById("status-message");
  const allocateBtn = document.getElementById("allocate-btn");
  if (!statusMessage) return;

  if (allocateBtn) allocateBtn.style.display = "none";

  statusMessage.style.color = "white";
  statusMessage.innerHTML = `
    <div style="margin-top:10px;">
      <div style="font-weight:bold;">🟡 You have an existing VM in STOPPED state.</div>
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
        setAllocateUIBusy(true, "Resuming VM... Please wait.");

        const base = await apiBase();
        const data = await fetchJson(`${base}/start_vm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ vm_id: vmInfo.vm_id }),
        });

        localStorage.setItem("vm_id", data.vm_id);
        localStorage.setItem("vm_ip", data.ip);

        window.location.href = "/status";
      } catch (e) {
        statusMessage.style.color = "red";
        statusMessage.textContent = `❌ Resume failed: ${e.message || e}`;
        setAllocateUIBusy(false);
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
        setAllocateUIBusy(true, "Terminating old VM...");

        const base = await apiBase();
        await fetchJson(`${base}/terminate_vm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ vm_id: vmInfo.vm_id }),
        });

        if (allocateBtn) {
          allocateBtn.style.display = "inline-block";
          allocateBtn.disabled = false;
        }

        statusMessage.style.color = "white";
        statusMessage.textContent = "Old VM terminated. Now allocate a new instance.";
        setAllocateUIBusy(false);

      } catch (e) {
        statusMessage.style.color = "red";
        statusMessage.textContent = `❌ Could not terminate old VM: ${e.message || e}`;
        setAllocateUIBusy(false);
      }
    });
  }
}

async function checkExistingVmAndRenderChoices() {
  const sb = await getSb();
  const statusMessage = document.getElementById("status-message");
  const allocateBtn = document.getElementById("allocate-btn");
  if (!sb || !statusMessage || !allocateBtn) return;

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;

    const accessToken = session.access_token;
    localStorage.setItem("sb_access_token", accessToken);

    const base = await apiBase();
    const info = await fetchJson(`${base}/my_vm`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });

    if (!info.exists) {
      allocateBtn.style.display = "inline-block";
      return;
    }

    if (info.vm_id) localStorage.setItem("vm_id", info.vm_id);
    if (info.ip) localStorage.setItem("vm_ip", info.ip);

    if (info.state === "stopped" || info.state === "stopping") {
      renderStoppedVmChoices(info, accessToken);
      return;
    }

    if (info.state === "running" && info.ip) {
      statusMessage.style.color = "white";
      statusMessage.textContent = `✅ You already have a running VM (${info.ip}). Redirecting to dashboard...`;
      setTimeout(() => (window.location.href = "/status"), 800);
      return;
    }

    statusMessage.style.color = "white";
    statusMessage.textContent = `ℹ️ Found existing VM (${info.state}).`;

  } catch (e) {
    console.warn("checkExistingVmAndRenderChoices failed:", e);
  }
}

// ==================================================
// ✅ ALLOCATE RAM (Protected)
//   - Requires Local Agent to be running (public-safe separation)
// ==================================================
async function allocateRAM() {
  const sb = await getSb();
  const allocateBtn = document.getElementById("allocate-btn");
  const loadingText = document.getElementById("loading-text");
  const statusMessage = document.getElementById("status-message");
  const ramSize = parseInt(document.getElementById("ram").value, 10);

  allocateBtn.disabled = true;
  loadingText.style.display = "block";
  loadingText.style.color = "blue";
  loadingText.textContent = "Processing... This may take 10-15 minutes.";
  statusMessage.textContent = "";

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error("Not logged in. Please login first.");

    const accessToken = session.access_token;
    localStorage.setItem("sb_access_token", accessToken);

    // ✅ Enforce Local Agent
    const agentOk = await isAgentOnline();
    if (!agentOk) throw new Error("Local Agent is not running. Start it and Retry.");

    const base = await apiBase();
    const data = await fetchJson(`${base}/allocate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ ram_size: ramSize }),
    });

    if (data.action_required) {
      renderStoppedVmChoices({ vm_id: data.vm_id, state: data.state, ip: data.ip }, accessToken);
      allocateBtn.disabled = false;
      loadingText.style.display = "none";
      return;
    }

    statusMessage.style.color = "white";
    statusMessage.textContent = "RAM allocated successfully!";
    localStorage.setItem("vm_ip", data.ip);
    localStorage.setItem("vm_id", data.vm_id);

    window.location.href = "/status";
  } catch (err) {
    statusMessage.style.color = "red";
    statusMessage.textContent = err.message || "Allocation failed.";
    allocateBtn.disabled = false;
  } finally {
    setTimeout(() => (loadingText.style.display = "none"), 2000);
  }
}

// ==================================================
// ✅ INIT
// ==================================================
document.addEventListener("DOMContentLoaded", async () => {
  navigate("login", false);

  const isSpa = document.getElementById("login-page") && document.getElementById("home-page");
  if (!isSpa) return;

  routeByPath();

  const sb = await getSb();
  if (!sb) return;

  sb.auth.onAuthStateChange(async () => {
    await refreshUIForSession();
  });

  await refreshUIForSession();

  // Allocate click
  const allocateBtn = document.getElementById("allocate-btn");
  if (allocateBtn) allocateBtn.addEventListener("click", allocateRAM);

  // Allocate page: wire agent gate buttons
  const retry = document.getElementById("allocate-agent-retry");
  if (retry) retry.addEventListener("click", enforceAgentGateOnAllocate);

  // ✅ NEW: Install & Run merged button
  const installRun = document.getElementById("allocate-install-run");
  if (installRun) installRun.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildInstallAndRunCommand());
      setAllocateGateUI({
        ok: false,
        msg: "📋 Install & Run command copied. Paste into PowerShell to install + start the agent, then click Retry."
      });
    } catch {
      setAllocateGateUI({ ok: false, msg: "❌ Could not copy. Open console for command." });
      console.log("INSTALL+RUN CMD:\n", buildInstallAndRunCommand());
    }
  });

  // If user lands directly on /allocate
  if (window.location.pathname.toLowerCase() === "/allocate") {
    // Only redirect after explicit Retry click (enforceAgentGateOnAllocate handles redirect when ok)
    const ok = await isAgentOnline();
    if (ok) {
      setAllocateGateUI({ ok: true, msg: "✅ Local Agent is running. Click Retry to go to status, or Allocate to continue." });
    } else {
      setAllocateGateUI({ ok: false, msg: "❌ Local Agent is NOT running. Install & run it, then click Retry." });
    }
    await checkExistingVmAndRenderChoices();
  }
});

window.addEventListener("popstate", () => routeByPath());
