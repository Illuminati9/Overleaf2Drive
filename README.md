# Overleaf2Drive Sync

> A Chrome Extension (Manifest V3) that lets you manually sync your compiled Overleaf PDFs directly to Google Drive.

## How It Works

1. **Install** the extension and click **Connect Google Drive** (one-time login) in the extension popup.
2. **Open any Overleaf project**. You will see a new **☁️ Drive Sync** button injected next to the standard Recompile button.
3. Click **Drive Sync**.
4. The first time you sync a project, the extension UI will automatically open and ask you to **Create New File**. It will create a new PDF in a **"Overleaf Sync"** folder in your Google Drive.
5. On subsequent syncs for that project, clicking the button will **update the existing file** so your sharing link never changes, appending a new version to its history without renaming the file on Drive.

---

## File Structure

```text
overtodrive/
├── manifest.json          # Extension configuration (MV3)
├── background.js          # Service worker: OAuth, Drive API, linking logic
├── content.js             # Injected into Overleaf: adds Sync button + fetches PDF
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.js           # Popup controller logic
│   └── popup.css          # Dark-theme glassmorphism styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md              # ← You are here
```

---

## Installation (Free via GitHub)

Since this extension is not published on the Chrome Web Store, you can install it manually in just 30 seconds:

1. **Download the Code**: Click the green **Code** button at the top of this repository and select **Download ZIP**.
2. **Extract**: Unzip the downloaded file to a folder on your computer.
3. **Open Extensions Page**: In Chrome (or Brave/Edge), type `chrome://extensions` in your address bar and press Enter.
4. **Enable Developer Mode**: Turn on the **Developer mode** toggle in the top-right corner.
5. **Load the Extension**: Click the **Load unpacked** button in the top-left and select the unzipped `overtodrive` folder.

That's it! The extension is now installed.

### Connecting your Google Account

1. Click the **Overleaf2Drive** icon (☁️) in your browser toolbar.
2. Click **Connect Google Drive**.
3. *Note: You may see a screen saying "Google hasn't verified this app" because this is an indie developer project. Simply click **Advanced** at the bottom, and then click **Go to Overleaf2Drive (unsafe)** to proceed.*
4. Log in and grant permission.

You are now ready to open any Overleaf project and click the **☁️ Drive Sync** button!

---

## Architecture

```text
┌─────────────────────────┐     ┌────────────────────────┐     ┌──────────────┐
│   Overleaf Page         │     │  Background Service    │     │ Google Drive │
│                         │     │  Worker                │     │              │
│  content.js:            │     │  background.js:        │     │              │
│  • Injects Sync button  │────▶│  • Gets OAuth token    │────▶│  • Folder:   │
│  • Handles manual click │     │  • Finds/creates       │     │    "Overleaf │
│  • Fetches PDF          │     │    sync folder         │     │     Sync"    │
│  • Sends base64 data    │     │  • Creates/updates     │     │  • PDF file  │
│                         │     │    PDF file            │     │              │
│  popup.html/js:         │     │  • Stores sync stats   │     │              │
│  • Auth UI              │────▶│  • Opens UI on 1st sync│     │              │
│  • Link Project UI      │     │                        │     │              │
└─────────────────────────┘     └────────────────────────┘     └──────────────┘
```

### Smart Syncing (background.js)

When uploading, the extension:
1. Checks if the project is already linked in local storage.
2. If no → Automatically opens the extension popup, prompting the user to create a new file in a folder named **"Overleaf Sync"** in Drive (creates it if missing).
3. If yes → uses `files.update` (PATCH) to replace content only — **the file ID and sharing link stay the same, and the file is not renamed on Drive**.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Not authenticated" in console | Click the extension icon and reconnect Google Drive |
| PDF not syncing | Check that you're on `overleaf.com` (not a self-hosted instance) |
| OAuth error | Make sure your Client ID is set correctly in `manifest.json` and your email is added as a test user |
| "Extension key" warning | The `"key"` field in `manifest.json` is optional; remove it or fill in your extension's public key |

---

## Tech Stack

- **Manifest V3** (Chrome Extension)
- **Pure JavaScript** (no frameworks)
- **Chrome Identity API** (`chrome.identity`) for OAuth2
- **Google Drive REST API v3** for file operations
- **CSS3** with custom properties and glassmorphism

---

## License

MIT
