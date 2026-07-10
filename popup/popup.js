/**
 * Overleaf2Drive — Popup Controller
 *
 * Manages three screens:
 *   1. Auth     — "Connect Google Drive" button.
 *   2. Linking  — "Create New" / "Link Existing PDF" choice for first sync.
 *   3. Dashboard — Sync stats, auto-sync toggle, linked project info.
 */

document.addEventListener('DOMContentLoaded', init);

/* ═══════════════════════════ Elements ═══════════════════════════ */

const $ = (sel) => document.querySelector(sel);

const els = {
  // Screens
  authSection:       $('#auth-section'),
  linkSection:       $('#link-section'),
  dashboardSection:  $('#dashboard-section'),

  // Auth
  btnConnect:        $('#btn-connect'),
  connectionDot:     $('#connection-dot'),

  // Linking
  linkProjectName:   $('#link-project-name'),
  linkChoices:       $('#link-choices'),
  btnCreateNew:      $('#btn-create-new'),

  // Dashboard
  btnDisconnect:     $('#btn-disconnect'),
  userName:          $('#user-name'),
  userEmail:         $('#user-email'),
  userAvatar:        $('#user-avatar'),
  syncCount:         $('#sync-count'),
  lastSyncTime:      $('#last-sync-time'),
  lastProjectRow:    $('#last-project-row'),
  lastProjectName:   $('#last-project-name'),
  
  // Status
  statusBar:         $('#status-bar'),
  statusText:        $('#status-text')
};

// Hold pending data so linking handlers can reference it.
let pendingData = null;
let searchTimer = null;

/* ═══════════════════════════ Init ═══════════════════════════ */

async function init() {
  // Wire handlers.
  els.btnConnect.addEventListener('click', handleConnect);
  els.btnDisconnect.addEventListener('click', handleDisconnect);
  els.btnCreateNew.addEventListener('click', handleCreateNew);
  
  setStatus('Checking connection…');

  // 1. Check auth.
  const authResp = await sendMessage({ action: 'checkAuth' });
  if (!authResp?.success) {
    showScreen('auth');
    return;
  }

  // 2. Check if there's a pending PDF waiting to be linked.
  const pendingResp = await sendMessage({ action: 'getPending' });
  if (pendingResp?.pending) {
    pendingData = pendingResp.pending;
    showScreen('link', authResp.user);
    return;
  }

  // 3. Otherwise show dashboard.
  showScreen('dashboard', authResp.user);
}

/* ═══════════════════════ Screen Management ═══════════════════════ */

function showScreen(name, user) {
  els.authSection.style.display = 'none';
  els.linkSection.style.display = 'none';
  els.dashboardSection.style.display = 'none';

  if (name === 'auth') {
    els.authSection.style.display = '';
    els.connectionDot.className = 'connection-dot';
    els.connectionDot.title = 'Disconnected';
    setStatus('Not connected');

  } else if (name === 'link') {
    els.linkSection.style.display = '';
    els.linkChoices.style.display = '';
    els.connectionDot.className = 'connection-dot connected';

    if (pendingData) {
      els.linkProjectName.textContent = pendingData.projectName || 'Untitled Project';
    }
    setStatus('Choose how to sync this project');
    populateUserInfo(user);

  } else if (name === 'dashboard') {
    els.dashboardSection.style.display = '';
    els.dashboardSection.classList.add('fade-in');
    els.connectionDot.className = 'connection-dot connected';
    els.connectionDot.title = 'Connected';
    populateUserInfo(user);
    setStatus('Connected — auto-syncing', 'success');
    loadStats();
  }
}

function populateUserInfo(user) {
  if (!user) return;
  els.userName.textContent = user.name || 'Google User';
  els.userEmail.textContent = user.email || '';
  els.userAvatar.textContent = (user.name || '?')[0];
}

async function loadStats() {
  const status = await sendMessage({ action: 'getStatus' });
  if (!status) return;

  if (status.syncCount != null) els.syncCount.textContent = status.syncCount;
  if (status.lastSync) els.lastSyncTime.textContent = formatRelativeTime(status.lastSync);
  if (status.lastProject || status.lastFileName) {
    els.lastProjectRow.style.display = '';
    els.lastProjectName.textContent = status.lastFileName || status.lastProject;
  }
  }

/* ═══════════════════════════ Auth ═══════════════════════════ */

async function handleConnect() {
  els.btnConnect.disabled = true;
  els.btnConnect.textContent = 'Connecting…';
  setStatus('Authenticating with Google…', 'syncing');

  const resp = await sendMessage({ action: 'authenticate' });

  if (resp?.success) {
    // After auth, check for pending PDF.
    const pendingResp = await sendMessage({ action: 'getPending' });
    if (pendingResp?.pending) {
      pendingData = pendingResp.pending;
      showScreen('link', resp.user);
    } else {
      showScreen('dashboard', resp.user);
    }
  } else {
    els.btnConnect.disabled = false;
    els.btnConnect.innerHTML = `<svg class="btn-icon" width="18" height="18" viewBox="0 0 18 18"><path d="M9 3L14 11H4L9 3Z" fill="#fff"/></svg> Connect Google Drive`;
    setStatus(resp?.error || 'Authentication failed', 'error');
  }
}

async function handleDisconnect() {
  const resp = await sendMessage({ action: 'disconnect' });
  if (resp?.success) {
    showScreen('auth');
    els.syncCount.textContent = '0';
    els.lastSyncTime.textContent = 'Never';
    els.lastProjectRow.style.display = 'none';
  }
}

/* ═══════════════════════ Linking: Create New ═══════════════════════ */

async function handleCreateNew() {
  if (!pendingData) return;

  els.btnCreateNew.disabled = true;
  setStatus('Creating file on Drive…', 'syncing');

  const resp = await sendMessage({
    action: 'createNewAndLink',
    data: { projectId: pendingData.projectId }
  });

  if (resp?.success) {
    pendingData = null;
    setStatus(`✅ Created "${resp.fileName}" on Drive`, 'success');
    // Brief pause so user sees the confirmation, then switch to dashboard.
    setTimeout(async () => {
      const auth = await sendMessage({ action: 'checkAuth' });
      showScreen('dashboard', auth?.user);
    }, 1200);
  } else {
    els.btnCreateNew.disabled = false;
    setStatus(resp?.error || 'Failed to create file', 'error');
  }
}


/* ═══════════════════════ Settings ═══════════════════════ */

/* ═══════════════════════════ Helpers ═══════════════════════════ */

function setStatus(text, type = '') {
  els.statusText.textContent = text;
  els.statusBar.className = `status-bar ${type}`;
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[popup]', chrome.runtime.lastError.message);
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

function formatRelativeTime(isoString) {
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 10)    return 'Just now';
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
