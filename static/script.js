// frontend/static/script.js (FULL FILE)
// ✅ Rules implemented:
// 1) NEVER auto-redirect to /status just because agent is running.
// 2) User MUST click Allocate.
// 3) On Allocate click: check /my_vm:
//    - if running + ip -> go /status
//    - if stopped/stopping -> show Resume + Create New buttons
//    - if no VM -> call /allocate to create new VM, then go /status
// 4) Allocate button enabled ONLY when agent is online.
// 5) Install & Run always copies (clipboard -> textarea -> prompt fallback)

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
// ✅ HELPERS
// ==================================================
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

async function isAgentOnline() {
  try {
    const r = await fetch(`${agentBase()}/health`, { cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

async function copyTextReliable(text) {
  // 1) modern clipboard
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "clipboard" };
    }
  } catch {}

  // 2) textarea fallback
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return { ok: true, method: "execCommand" };
  } catch {}

  // 3) prompt fallback
  try {
    window.prompt("Copy this command:", text);
    return { ok: true, method: "prompt" };
  } catch {
    return { ok: false, method: "none" };
  }
}

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

async function getAccessToken() {
  const sb = await getSb();
  if (!sb) return "";
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token || "";
}

async function getMyVmInfo(accessToken) {
  const base = await apiBase();
  return await fetchJson(`${base}/my_vm`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
}

// ==================================================
// ✅ UI HELPERS
// ==================================================
function setGateStatus(ok, msg) {
  const gateEl = document.getElementById("allocate-agent-status");
  const allocateBtn = document.getElementById("allocate-btn");

  if (gateEl) {
    gateEl.textContent = msg || "";
    gateEl.style.color = ok ? "lightgreen" : "crimson";
  }

  // ✅ allocate enabled ONLY when agent online
  if (allocateBtn) allocateBtn.disabled = !ok;
}

function setBusy(isBusy, msg = "") {
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

function clearStatus() {
  const statusMessage = document.getElementById("status-message");
  if (statusMessage) {
    statusMessage.textContent = "";
    statusMessage.style.color = "white";
  }
}

// ==================================================
// ✅ INSTALL/RUN COMMANDS
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

function buildInstallAndRunCommand() {
  return `${buildInstallCommand()} ; ${buildRunCommand()}`;
}

// ==================================================
// ✅ RESUME/NEW UI (for STOPPED VM)
// ==================================================
function renderStoppedVmChoices(vmInfo, accessToken) {
  const statusMessage = document.getElementById("status-message");
  const allocateBtn = document.getElementById("allocate-btn");
  if (!statusMessage) return;

  // Hide allocate while showing choices
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
        setBusy(true, "Resuming VM... Please wait.");
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
        if (data.ip) localStorage.setItem("vm_ip", data.ip);

        // after resume, go dashboard
        window.location.href = "/status";
      } catch (e) {
        setBusy(false);
        const sm = document.getElementById("status-message");
        if (sm) {
          sm.style.color = "crimson";
          sm.textContent = `❌ Resume failed: ${e.message || e}`;
        }
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
        setBusy(true, "Terminating old VM...");
        const base = await apiBase();

        await fetchJson(`${base}/terminate_vm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ vm_id: vmInfo.vm_id }),
        });

        // Restore allocate UI
        const allocateBtn2 = document.getElementById("allocate-btn");
        if (allocateBtn2) {
          allocateBtn2.style.display = "inline-block";
          allocateBtn2.disabled = !(await isAgentOnline());
        }

        const sm = document.getElementById("status-message");
        if (sm) {
          sm.style.color = "white";
          sm.textContent = "✅ Old VM terminated. Click Allocate to create a new instance.";
        }

        setBusy(false);
      } catch (e) {
        setBusy(false);
        const sm = document.getElementById("status-message");
        if (sm) {
          sm.style.color = "crimson";
          sm.textContent = `❌ Could not terminate old VM: ${e.message || e}`;
        }
      }
    });
  }
}

// ==================================================
// ✅ MAIN: Allocate click flow (your exact requirement)
// ==================================================
async function allocateClickFlow() {
  clearStatus();

  // 0) must have agent online
  const agentOk = await isAgentOnline();
  if (!agentOk) {
    setGateStatus(false, "❌ Local Agent is NOT running. Install & run it first.");
    return;
  }

  setBusy(true, "Checking existing VM...");

  const accessToken = await getAccessToken();
  if (!accessToken) {
    setBusy(false);
    const sm = document.getElementById("status-message");
    if (sm) {
      sm.style.color = "crimson";
      sm.textContent = "❌ Not logged in. Please login again.";
    }
    return;
  }

  // 1) check existing vm
  let info;
  try {
    info = await getMyVmInfo(accessToken);
  } catch (e) {
    setBusy(false);
    const sm = document.getElementById("status-message");
    if (sm) {
      sm.style.color = "crimson";
      sm.textContent = `❌ my_vm failed: ${e.message || e}`;
    }
    return;
  }

  if (info.exists) {
    if (info.vm_id) localStorage.setItem("vm_id", info.vm_id);
    if (info.ip) localStorage.setItem("vm_ip", info.ip);

    // 2a) running -> go dashboard
    if (info.state === "running" && info.ip) {
      setBusy(true, "✅ VM is already running. Opening dashboard...");
      window.location.href = "/status";
      return;
    }

    // 2b) stopped -> show buttons
    if (info.state === "stopped" || info.state === "stopping") {
      setBusy(false);
      renderStoppedVmChoices(info, accessToken);
      return;
    }

    // other state
    setBusy(false);
    const sm = document.getElementById("status-message");
    if (sm) {
      sm.style.color = "white";
      sm.textContent = `ℹ️ Existing VM found (${info.state}). Please wait and try again.`;
    }
    return;
  }

  // 3) no existing vm -> allocate new
  const ramSize = parseInt(document.getElementById("ram").value, 10);
  setBusy(true, "Creating new VM... This may take 10-15 minutes.");

  try {
    const base = await apiBase();
    const data = await fetchJson(`${base}/allocate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ ram_size: ramSize }),
    });

    // If backend returns action_required (stopped VM found server-side)
    if (data.action_required) {
      setBusy(false);
      renderStoppedVmChoices({ vm_id: data.vm_id, state: data.state, ip: data.ip }, accessToken);
      return;
    }

    localStorage.setItem("vm_id", data.vm_id);
    if (data.ip) localStorage.setItem("vm_ip", data.ip);

    setBusy(true, "✅ VM created. Opening dashboard...");
    window.location.href = "/status";
  } catch (e) {
    setBusy(false);
    const sm = document.getElementById("status-message");
    if (sm) {
      sm.style.color = "crimson";
      sm.textContent = `❌ Allocation failed: ${e.message || e}`;
    }
  }
}

// ==================================================
// ✅ NAVIGATION (SPA)
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

  // When opening allocate page: just update gate + enable/disable allocate button.
  // ✅ NO redirects here.
  if (page === "allocate") {
    setTimeout(async () => {
      const ok = await isAgentOnline();
      setGateStatus(
        ok,
        ok
          ? "✅ Local Agent is running. Click Allocate to continue."
          : "❌ Local Agent is NOT running. Click Install & Run Agent, then Retry Agent."
      );

      // restore allocate button visibility if it was hidden by stopped-vm choices
      const allocateBtn = document.getElementById("allocate-btn");
      if (allocateBtn) allocateBtn.style.display = "inline-block";

      // do not check /my_vm here (per your requirement)
    }, 0);
  }
}

function routeByPath() {
  const path = window.location.pathname.toLowerCase();
  if (path === "/register") return navigate("register", false);
  if (path === "/login") return navigate("login", false);
  if (path === "/allocate") return navigate("allocate", false);
  if (path === "/" || path === "") return navigate("home", false);
  return navigate("login", false);
}

window.navigate = navigate;

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
// ✅ INIT
// ==================================================
document.addEventListener("DOMContentLoaded", async () => {
  // Start on route (SPA)
  routeByPath();

  const sb = await getSb();
  if (!sb) return;

  // If auth changes, refresh UI
  sb.auth.onAuthStateChange(async () => {
    await refreshUIForSession();
  });

  await refreshUIForSession();

  // Allocate click (ONLY triggers VM logic)
  const allocateBtn = document.getElementById("allocate-btn");
  if (allocateBtn) allocateBtn.addEventListener("click", allocateClickFlow);

  // Retry Agent: only checks agent + enables Allocate; ✅ NO redirect
  const retry = document.getElementById("allocate-agent-retry");
  if (retry) {
    retry.addEventListener("click", async () => {
      const ok = await isAgentOnline();
      setGateStatus(
        ok,
        ok
          ? "✅ Local Agent is running. Click Allocate to continue."
          : "❌ Local Agent is NOT running. Click Install & Run Agent, then Retry Agent."
      );
    });
  }

  // Install & Run: reliable copy
  const installRun = document.getElementById("allocate-install-run");
  if (installRun) {
    installRun.addEventListener("click", async () => {
      const cmd = buildInstallAndRunCommand();
      const res = await copyTextReliable(cmd);
      setGateStatus(false, res.ok
        ? `📋 Install & Run command copied (${res.method}). Paste into PowerShell, then click Retry Agent.`
        : "❌ Could not copy automatically. Open console for the command."
      );
      if (!res.ok) console.log("INSTALL+RUN CMD:\n", cmd);
    });
  }

  window.addEventListener("popstate", () => routeByPath());
});
