# Build the Mac DMG

Apple only allows a proper `.dmg` to be built **on macOS**. This Windows PC cannot produce one (`electron-builder`: “Build for macOS is supported only on macOS”).

## Option A — GitHub Actions (recommended)

1. Push this repo to GitHub (`Kohindgs/dgs-auto-editor`).
2. Open **Actions → Build Mac DMG → Run workflow**.
3. Download the `dgs-auto-editor-mac` artifact (`.dmg` + `.zip`).
4. Attach those files to a GitHub Release so **Updates** can offer them.

Optional: set repo secret `MPV_MAC_URL` to a `.tgz` that unpacks `libmpv*.dylib` into `native_editor/vendor/mpv-mac/`.

## Option B — Build on a Mac

```bash
# once
brew install ffmpeg tesseract
cd hostinger_deploy && npm ci --omit=dev
cd ../desktop && npm ci

# optional libmpv for native preview
mkdir -p ../native_editor/vendor/mpv-mac
# copy libmpv.2.dylib (and deps) into that folder

CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
open release
```

Install: open `DGS-Auto-Editor-Beta-*.dmg` → drag **DGS Auto Editor Beta** to Applications.

Unsigned builds: right-click → Open the first time (Gatekeeper).

## After you have a DMG

1. Upload EXE + DMG to GitHub Releases.
2. Bump `frontend/public/updates.json` version + notes.
3. Deploy Hostinger so `/updates.json` and `/api/app/version` are live.
4. Teammates get **Updates · new** and can download.
