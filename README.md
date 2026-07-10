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

## Setup Instructions

### Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Click **Select a project** → **New Project**.
3. Name it `Overleaf2Drive` (or anything you like) and click **Create**.
4. Make sure the new project is selected in the top-left dropdown.

### Step 2: Enable the Google Drive API

1. In the Cloud Console, go to **APIs & Services** → **Library**.
2. Search for **Google Drive API** and click on it.
3. Click **Enable**.

### Step 3: Configure the OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**.
2. Select **External** user type and click **Create**.
3. Fill in the required fields:
   - **App name**: `Overleaf2Drive`
   - **User support email**: Your email
   - **Developer contact**: Your email
4. Click **Save and Continue** through the remaining steps.
5. Under **Test users**, add your own Google email address.

### Step 4: Create OAuth2 Credentials

1. Go to **APIs & Services** → **Credentials**.
2. Click **+ Create Credentials** → **OAuth client ID**.
3. Set **Application type** to **Chrome Extension**.
4. You'll need your extension's ID. To get it:
   - First, load the extension in Chrome (see Step 5).
   - Copy the extension ID from `chrome://extensions`.
   - Come back here and paste it into the **Item ID** field.
5. Click **Create** and copy the **Client ID** (looks like `123456789.apps.googleusercontent.com`).

### Step 5: Configure & Load the Extension

1. **Set the Client ID**: Open `manifest.json` and replace the placeholder:
   ```json
   "oauth2": {
     "client_id": "YOUR_ACTUAL_CLIENT_ID.apps.googleusercontent.com",
     ...
   }
   ```

2. **Load in Chrome**:
   - Open `chrome://extensions/` in Chrome.
   - Enable **Developer mode** (toggle in the top-right).
   - Click **Load unpacked**.
   - Select the `overtodrive` project folder.
   - Note the **Extension ID** shown on the card.

3. **Finish OAuth Setup** (if you haven't already):
   - Go back to the Google Cloud Console → Credentials.
   - Edit your OAuth client and set the **Item ID** to the extension ID from above.

### Step 6: Connect & Use

1. Click the **Overleaf2Drive** icon in your Chrome toolbar.
2. Click **Connect Google Drive** and authorize with your Google account.
3. Open any project on [Overleaf](https://www.overleaf.com) and you will see the **Drive Sync** button. Click it to sync!

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
