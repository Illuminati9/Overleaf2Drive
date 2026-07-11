/**
 * Overleaf2Drive — Content Script
 * 
 * Injected into https://www.overleaf.com/project/* pages.
 * 
 * Responsibilities:
 *   1. Extract the project ID from the URL.
 *   2. Detect when a recompile finishes (via XHR/fetch interception + DOM observer).
 *   3. Fetch the compiled PDF using the user's Overleaf session.
 *   4. Encode the PDF as base64 and send it to background.js for Drive upload.
 */

(function () {
  'use strict';

  /* ──────────────────────────── Guards ──────────────────────────── */

  const PROJECT_ID_RE = /\/project\/([a-f0-9]{24})/;
  const match = window.location.pathname.match(PROJECT_ID_RE);
  if (!match) return; // Not inside a project editor — bail out.

  const projectId = match[1];
  let isSyncing = false;

  /* ────────────── UI Integration ────────── */
  // Inject a manual "Sync to Drive" button next to the Recompile button.

  function setupUI() {

    // Inject manual Sync button
    setInterval(() => {
      if (document.getElementById('o2d-manual-sync')) return;

      // Try common classes and aria attributes
      let recompileBtn = document.querySelector('.btn-recompile, [aria-label*="Recompile" i], button[class*="recompile" i], [tooltip*="Recompile" i]');
      
      // Fallback: iterate over buttons to find the text "Recompile"
      if (!recompileBtn) {
        const buttons = Array.from(document.querySelectorAll('button'));
        recompileBtn = buttons.find(b => (b.innerText || '').toLowerCase().includes('recompile'));
      }

      if (!recompileBtn) return;
      
      const parent = recompileBtn.parentElement;
      if (parent) {
        const syncBtn = document.createElement('button');
        syncBtn.id = 'o2d-manual-sync';
        // Match Overleaf button styles generally
        syncBtn.className = recompileBtn.className;
        syncBtn.style.backgroundColor = '#6385ff';
        syncBtn.style.color = '#fff';
        syncBtn.style.border = 'none';
        syncBtn.style.marginLeft = '8px';
        syncBtn.style.marginRight = '8px';
        syncBtn.style.borderRadius = '4px';
        syncBtn.style.padding = '0 12px';
        syncBtn.style.fontWeight = 'bold';
        syncBtn.style.cursor = 'pointer';
        syncBtn.innerHTML = '☁️ Drive Sync';
        syncBtn.title = 'Force sync current PDF to Google Drive';
        
        syncBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          triggerSync();
        };

        parent.insertBefore(syncBtn, recompileBtn.nextSibling);
      }
    }, 2000);
  }

  // Start UI setup
  setupUI();

  // The MutationObserver fallback was removed because it triggers on scrolls,
  // zooms, and page changes, causing continuous unwanted syncs. The network
  // interceptor (Strategy 1) is fully sufficient and only triggers exactly
  // when a compile finishes.

  /* ──────────────────── Sync Logic ──────────────────── */

  /**
   * Fetch the compiled PDF and hand it to the background service worker.
   */
  async function triggerSync() {
    if (isSyncing) return;

    isSyncing = true;
    
    if (isCompiling()) {
      showToast('⏳ Waiting for compile to finish…', 'syncing');
      while (isCompiling()) {
        await new Promise(r => setTimeout(r, 500));
      }
      // Give the server a small grace period to flush the new PDF
      await new Promise(r => setTimeout(r, 1000));
    }

    showToast('⏳ Syncing PDF to Google Drive…', 'syncing');

    try {
      const projectName = getProjectName();
      const pdfUrl = getPdfUrl();

      if (!pdfUrl) {
        throw new Error("Could not find the PDF URL on the page.");
      }

      // Fetch the PDF using the page's Overleaf session cookies.
      const response = await fetch(pdfUrl, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`PDF fetch failed (${response.status})`);
      }

      const blob = await response.blob();

      // Convert blob → base64 for message passing.
      const base64 = await blobToBase64(blob);

      // Send to the background service worker.
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action: 'uploadPDF',
            data: {
              base64,
              projectId,
              projectName,
              fileName: `${projectName}.pdf`
            }
          },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(resp);
            }
          }
        );
      });

      if (result.needsLinking) {
        // First time for this project — user needs to choose in the popup window that just opened.
        showToast('📎 Setup window opened to link this project', 'info');
      } else if (result.success) {
        showToast('✅ Synced to Google Drive!', 'success');
        console.log('[Overleaf2Drive] Upload complete — file ID:', result.fileId);
      } else {
        throw new Error(result.error || 'Upload failed');
      }
    } catch (err) {
      console.error('[Overleaf2Drive] Sync error:', err);
      showToast(`❌ Sync failed: ${err.message}`, 'error');
    } finally {
      isSyncing = false;
    }
  }

  /* ──────────────────── Helpers ──────────────────── */

  /**
   * Check if Overleaf is currently compiling the document.
   */
  function isCompiling() {
    // Check if recompile button is disabled
    const recompileBtn = document.querySelector('.btn-recompile, [aria-label*="Recompile" i], button[class*="recompile" i]');
    if (recompileBtn && recompileBtn.disabled) return true;
    
    // Check for "Compiling..." text in buttons
    const buttons = Array.from(document.querySelectorAll('button'));
    const compilingBtn = buttons.find(b => (b.innerText || '').toLowerCase().includes('compiling'));
    if (compilingBtn) return true;

    // Check for specific progress indicators or spinners in the recompile button
    const recompileIcon = document.querySelector('.btn-recompile .fa-spin, .compile-progress-bar');
    if (recompileIcon) return true;

    return false;
  }

  /**
   * Extract the actual PDF URL from the page.
   * Overleaf requires query parameters (like compileGroup, clsiserverid) 
   * for the download URL to work properly without a 404.
   */
  function getPdfUrl() {
    // 1. Try to find the "Download PDF" button
    const downloadBtns = document.querySelectorAll('a[href*="/output/"]');
    for (const btn of downloadBtns) {
      const href = btn.getAttribute('href');
      if (href && href.includes('.pdf')) {
        return href;
      }
    }

    // 2. Try to find the PDF viewer iframe or object
    const viewers = document.querySelectorAll('iframe[src*="/output/"], object[data*="/output/"], embed[src*="/output/"]');
    for (const el of viewers) {
      const url = el.src || el.data;
      if (url && url.includes('.pdf')) {
        return url;
      }
    }

    // 3. Fallback (might 404 depending on the project's compiler settings)
    return `/project/${projectId}/output/output.pdf?compileGroup=standard&_cb=${Date.now()}`;
  }

  /** Extract the human-readable project name from the DOM or page title. */
  function getProjectName() {
    // Overleaf v2/v3 project name selectors (most → least specific).
    const nameSelectors = [
      'input.project-name',              // Editable name input
      '.toolbar-header .name',            // Toolbar project name
      '[class*="project-name"]',          // Any element with project-name class
      '.editor-header .name'
    ];

    for (const sel of nameSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const name = (el.value || el.textContent || '').trim();
        if (name) return sanitizeFileName(name);
      }
    }

    // Fallback: strip boilerplate from <title>.
    const title = document.title
      .replace(/\s*[-–—|]\s*Overleaf.*$/i, '')
      .trim();

    return sanitizeFileName(title || `overleaf-${projectId.slice(0, 8)}`);
  }

  /** Remove characters that are illegal in file names. */
  function sanitizeFileName(name) {
    return name.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim();
  }

  /** Convert a Blob to a base64-encoded string (without the data-url prefix). */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /* ──────────────────── Toast UI ──────────────────── */

  function showToast(message, type = 'info') {
    let toast = document.getElementById('o2d-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'o2d-toast';
      Object.assign(toast.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: '2147483647',
        padding: '14px 22px',
        borderRadius: '12px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: '14px',
        fontWeight: '500',
        lineHeight: '1.4',
        maxWidth: '340px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        transition: 'opacity 0.4s ease, transform 0.4s ease',
        opacity: '0',
        transform: 'translateY(12px) scale(0.95)',
        pointerEvents: 'none'
      });
      document.body.appendChild(toast);
    }

    // Colour by type
    const themes = {
      syncing:  { bg: 'rgba(30, 41, 82, 0.92)',  border: '1px solid rgba(99,133,255,0.3)', color: '#a8b8ff' },
      success:  { bg: 'rgba(22, 54, 38, 0.92)',   border: '1px solid rgba(46,204,113,0.3)', color: '#6ee7a0' },
      error:    { bg: 'rgba(68, 22, 22, 0.92)',    border: '1px solid rgba(231,76,60,0.3)',  color: '#f5a3a3' },
      info:     { bg: 'rgba(26, 26, 46, 0.92)',    border: '1px solid rgba(255,255,255,0.1)', color: '#e0e0e0' }
    };
    const t = themes[type] || themes.info;

    Object.assign(toast.style, {
      background: t.bg,
      border: t.border,
      color: t.color
    });

    toast.textContent = message;
    // Force reflow then animate in.
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0) scale(1)';
    });

    // Auto-dismiss (longer for errors so users can read them).
    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(12px) scale(0.95)';
    }, type === 'error' ? 6000 : 4000);
  }

  /* ──────────────────── Init ──────────────────── */

  // Tell the background we're alive on this tab.
  chrome.runtime.sendMessage({
    action: 'contentScriptReady',
    data: { projectId, projectName: getProjectName() }
  });

  console.log(
    `[Overleaf2Drive] Content script loaded — project: ${projectId}`
  );
})();
