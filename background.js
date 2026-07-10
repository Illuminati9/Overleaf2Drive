/**
 * Overleaf2Drive — Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *   1. Manage Google OAuth2 tokens via chrome.identity.
 *   2. Store project ↔ Drive file links in chrome.storage.
 *   3. Handle PDF uploads to Google Drive (create / smart-overwrite).
 *   4. Queue unlinked projects and notify user via badge.
 */

/* ══════════════════════════ Constants ══════════════════════════ */

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const SYNC_FOLDER_NAME = 'Overleaf Sync';

/* ══════════════════════════ Message Router ══════════════════════════ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    // ── Auth ──
    authenticate:      () => handleAuthenticate(),
    checkAuth:         () => handleCheckAuth(),
    disconnect:        () => handleDisconnect(),

    // ── Sync ──
    uploadPDF:         () => handleUpload(message.data),
    getStatus:         () => handleGetStatus(),

    // ── Linking ──
    getPending:        () => handleGetPending(),
    createNewAndLink:  () => handleCreateNewAndLink(message.data),
    linkExisting:      () => handleLinkExisting(message.data),
    searchDrivePDFs:   () => handleSearchDrivePDFs(message.data),
    unlinkProject:     () => handleUnlinkProject(message.data),
    getProjectLinks:   () => handleGetProjectLinks(),

    // ── Misc ──
    contentScriptReady: () => {
      console.log('[Overleaf2Drive] Content script active — project:', message.data?.projectId);
      return Promise.resolve({ ack: true });
    }
  };

  const handler = handlers[message.action];
  if (!handler) return false;

  handler()
    .then((result) => sendResponse(result))
    .catch((err) => {
      console.error(`[Overleaf2Drive] ${message.action} error:`, err);
      sendResponse({ success: false, error: err.message });
    });

  return true; // Keep the message channel open for async response.
});

/* ══════════════════════ Authentication ══════════════════════ */

function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error('No auth token received'));
      } else {
        resolve(token);
      }
    });
  });
}

async function fetchUserInfo(token) {
  const resp = await fetch(
    `${DRIVE_API_BASE}/about?fields=user(displayName,emailAddress)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) throw new Error('Failed to fetch user info');
  const data = await resp.json();
  return { name: data.user.displayName, email: data.user.emailAddress };
}

async function handleAuthenticate() {
  const token = await getAuthToken(true);
  const user = await fetchUserInfo(token);
  await chrome.storage.local.set({ userEmail: user.email, userName: user.name });
  return { success: true, user };
}

async function handleCheckAuth() {
  try {
    const token = await getAuthToken(false);
    const user = await fetchUserInfo(token);
    return { success: true, user };
  } catch {
    return { success: false };
  }
}

function handleDisconnect() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        chrome.identity.removeCachedAuthToken({ token }, () => {
          fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
          chrome.storage.local.remove(
            ['lastSync', 'syncCount', 'lastProject', 'lastFileName',
             'lastFileId', 'userEmail', 'userName', 'pendingPDF', 'projectLinks'],
            () => resolve({ success: true })
          );
        });
      } else {
        resolve({ success: true });
      }
    });
  });
}

async function handleGetStatus() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['lastSync', 'syncCount', 'lastProject', 'lastFileName', 'lastError'],
      (data) => resolve(data)
    );
  });
}

/* ═══════════════════ Project ↔ Drive Link Storage ═══════════════════ */

/**
 * Storage schema for project links:
 * {
 *   "projectLinks": {
 *     "<overleaf_project_id>": {
 *       "driveFileId": "...",
 *       "driveFileName": "...",
 *       "projectName": "...",
 *       "linkedAt": "ISO string"
 *     }
 *   }
 * }
 */

/** Get the Drive file ID linked to a given Overleaf project, or null. */
async function getProjectLink(projectId) {
  const { projectLinks = {} } = await chrome.storage.local.get('projectLinks');
  return projectLinks[projectId] || null;
}

/** Store a project ↔ Drive file mapping. */
async function saveProjectLink(projectId, driveFileId, driveFileName, projectName) {
  const { projectLinks = {} } = await chrome.storage.local.get('projectLinks');
  projectLinks[projectId] = {
    driveFileId,
    driveFileName,
    projectName,
    linkedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ projectLinks });
}

/** Remove a project link. */
async function removeProjectLink(projectId) {
  const { projectLinks = {} } = await chrome.storage.local.get('projectLinks');
  delete projectLinks[projectId];
  await chrome.storage.local.set({ projectLinks });
}

async function handleGetProjectLinks() {
  const { projectLinks = {} } = await chrome.storage.local.get('projectLinks');
  return { success: true, links: projectLinks };
}

async function handleUnlinkProject({ projectId }) {
  await removeProjectLink(projectId);
  return { success: true };
}

/* ════════════════════ Pending PDF Queue ════════════════════ */

/**
 * When a compile finishes but no link exists for the project,
 * we stash the PDF data here and show a badge so the user
 * knows to open the popup and choose how to link.
 */

async function storePendingPDF(data) {
  await chrome.storage.local.set({ pendingPDF: data });
  // Light up the badge.
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#6385ff' });
}

async function clearPendingPDF() {
  await chrome.storage.local.remove('pendingPDF');
  chrome.action.setBadgeText({ text: '' });
}

async function handleGetPending() {
  const { pendingPDF } = await chrome.storage.local.get('pendingPDF');
  return { success: true, pending: pendingPDF || null };
}

/* ══════════════════════ PDF Upload Pipeline ══════════════════════ */

/**
 * Called by the content script after every compile.
 *
 * Flow:
 *   1. Check if this project already has a linked Drive file.
 *      → YES: Upload/overwrite that file silently (auto-sync).
 *      → NO:  Stash the PDF data and notify the user to pick a target.
 */
async function handleUpload({ base64, projectId, projectName, fileName }) {
  const link = await getProjectLink(projectId);

  if (link) {
    // ── Auto-sync: project is already linked ──
    return await syncToLinkedFile(link.driveFileId, base64, fileName, projectName, projectId);
  }

  // ── First time: stash and ask the user ──
  await storePendingPDF({ base64, projectId, projectName, fileName });
  
  // Automatically open the extension UI to prompt linking
  chrome.windows.create({
    url: 'popup/popup.html',
    type: 'popup',
    width: 400,
    height: 600,
    focused: true
  });

  return {
    success: false,
    needsLinking: true,
    message: 'Project not linked yet — opening setup window.'
  };
}

/** Upload/overwrite into an already-linked Drive file. */
async function syncToLinkedFile(driveFileId, base64, fileName, projectName, projectId) {
  const token = await getAuthToken(false);
  const pdfBlob = base64ToBlob(base64, 'application/pdf');

  const result = await updateFile(token, driveFileId, fileName, pdfBlob);

  // Update the link's cached filename in case the project was renamed.
  await saveProjectLink(projectId, driveFileId, fileName, projectName);

  // Stats.
  const count = (await storageGet('syncCount')) || 0;
  await chrome.storage.local.set({
    lastSync: new Date().toISOString(),
    syncCount: count + 1,
    lastProject: projectName,
    lastFileName: fileName,
    lastFileId: result.id,
    lastError: null
  });

  console.log('[Overleaf2Drive] Auto-synced to linked file:', driveFileId);
  return { success: true, fileId: result.id, webViewLink: result.webViewLink };
}

/* ════════════════════ Linking Handlers ════════════════════ */

/**
 * Use-case 1: User chooses "Create New File" in the popup.
 * Creates a new PDF in the Overleaf Sync folder, links it, and clears the queue.
 */
async function handleCreateNewAndLink({ projectId }) {
  const { pendingPDF } = await chrome.storage.local.get('pendingPDF');
  if (!pendingPDF || pendingPDF.projectId !== projectId) {
    throw new Error('No pending PDF for this project');
  }

  const token = await getAuthToken(false);
  const folderId = await findOrCreateFolder(token);
  const pdfBlob = base64ToBlob(pendingPDF.base64, 'application/pdf');

  const result = await createNewFile(
    token, pendingPDF.fileName, folderId, projectId, pdfBlob
  );

  // Store the link.
  await saveProjectLink(projectId, result.id, pendingPDF.fileName, pendingPDF.projectName);

  // Stats.
  const count = (await storageGet('syncCount')) || 0;
  await chrome.storage.local.set({
    lastSync: new Date().toISOString(),
    syncCount: count + 1,
    lastProject: pendingPDF.projectName,
    lastFileName: pendingPDF.fileName,
    lastFileId: result.id,
    lastError: null
  });

  await clearPendingPDF();
  console.log('[Overleaf2Drive] Created and linked new file:', result.id);
  return { success: true, fileId: result.id, fileName: pendingPDF.fileName };
}

/**
 * Use-case 2: User chooses "Link Existing File" and picks a PDF from Drive.
 * Overwrites that file's content with the pending PDF and stores the link.
 */
async function handleLinkExisting({ projectId, driveFileId, driveFileName }) {
  const { pendingPDF } = await chrome.storage.local.get('pendingPDF');
  if (!pendingPDF || pendingPDF.projectId !== projectId) {
    throw new Error('No pending PDF for this project');
  }

  const token = await getAuthToken(false);
  const pdfBlob = base64ToBlob(pendingPDF.base64, 'application/pdf');

  // Overwrite the chosen file's content (keep its name and sharing link).
  const result = await updateFile(token, driveFileId, driveFileName, pdfBlob);

  // Tag the file with the Overleaf project ID for future lookups.
  await fetch(`${DRIVE_API_BASE}/files/${driveFileId}`, {
    method: 'PATCH',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ appProperties: { overleafProjectId: projectId } })
  });

  // Store the link.
  await saveProjectLink(projectId, driveFileId, driveFileName, pendingPDF.projectName);

  // Stats.
  const count = (await storageGet('syncCount')) || 0;
  await chrome.storage.local.set({
    lastSync: new Date().toISOString(),
    syncCount: count + 1,
    lastProject: pendingPDF.projectName,
    lastFileName: driveFileName,
    lastFileId: driveFileId,
    lastError: null
  });

  await clearPendingPDF();
  console.log('[Overleaf2Drive] Linked to existing file:', driveFileId);
  return { success: true, fileId: driveFileId, fileName: driveFileName };
}

/**
 * Search the user's Drive for PDF files (to let them pick one to link).
 */
async function handleSearchDrivePDFs({ query }) {
  const token = await getAuthToken(false);

  let q = "mimeType='application/pdf' and trashed=false";
  if (query && query.trim()) {
    q += ` and name contains '${escapeDriveQuery(query.trim())}'`;
  }

  const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,parents)&orderBy=modifiedTime desc&pageSize=20`;

  const resp = await fetch(url, { headers: authHeader(token) });
  if (!resp.ok) throw new Error('Drive search failed');
  const data = await resp.json();

  return { success: true, files: data.files || [] };
}

/* ═══════════════════ Google Drive Helpers ═══════════════════ */

async function findOrCreateFolder(token) {
  const q = `name='${SYNC_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;

  const resp = await fetch(url, { headers: authHeader(token) });
  const data = await resp.json();

  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  const createResp = await fetch(`${DRIVE_API_BASE}/files`, {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: SYNC_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });

  if (!createResp.ok) {
    throw new Error(`Failed to create Drive folder (${createResp.status})`);
  }

  const folder = await createResp.json();
  return folder.id;
}

async function createNewFile(token, fileName, folderId, projectId, blob) {
  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType: 'application/pdf',
    appProperties: { overleafProjectId: projectId }
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  
  // Create a nice version label like "ProjectName_2026-07-10.pdf" for Drive's version history
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const versionLabel = fileName.replace(/\.pdf$/i, '') + `_${dateStr}.pdf`;
  form.append('file', blob, versionLabel);

  const resp = await fetch(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink,appProperties`,
    { method: 'POST', headers: authHeader(token), body: form }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Drive upload failed (${resp.status}): ${err}`);
  }
  return resp.json();
}

async function updateFile(token, fileId, newFileName, blob) {
  // Do not include 'name' in metadata to prevent renaming the existing Drive file
  const metadata = {};
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  
  // Create a nice version label like "ProjectName_2026-07-10.pdf" for Drive's version history
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  const versionLabel = newFileName.replace(/\.pdf$/i, '') + `_${dateStr}.pdf`;
  form.append('file', blob, versionLabel);

  const resp = await fetch(
    `${DRIVE_UPLOAD_BASE}/files/${fileId}?uploadType=multipart&fields=id,name,webViewLink`,
    { method: 'PATCH', headers: authHeader(token), body: form }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Drive update failed (${resp.status}): ${err}`);
  }
  return resp.json();
}

/* ══════════════════════════ Utilities ══════════════════════════ */

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

function escapeDriveQuery(str) {
  return str.replace(/'/g, "\\'");
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result[key]));
  });
}

/* ══════════════════════════ Init ══════════════════════════ */

console.log('[Overleaf2Drive] Background service worker initialised');
