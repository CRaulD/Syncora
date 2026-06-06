<p align="center">
  <img src="public/syncora-icon.svg" alt="Syncora" width="96" />
</p>

<h1 align="center">Syncora</h1>

<p align="center">
  Desktop app to find, download, and sync subtitles for video files.
  <br />
  Built with Tauri + React + FastAPI, ships a native Windows installer.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/version-0.1.0--beta-orange.svg" alt="Version" />
  <img src="https://img.shields.io/badge/platform-Windows-0078d4.svg" alt="Platform" />
  <a href="https://github.com/CRaulD/Syncora/releases"><img src="https://img.shields.io/badge/download-Windows%20Installer-success.svg" alt="Download" /></a>
</p>

<p align="center">
  <strong>🌐 Language:</strong> <strong>English</strong> · <a href="README.pt-BR.md">Português (BR)</a>
</p>

---

## Overview

Syncora scans a folder (or files opened from Explorer), looks up subtitles from configured providers, downloads them, and syncs them to the video using **ALASS**. It can optionally mux softsubs into the final file with **FFmpeg**/**FFprobe**.

![Main window](docs/screenshots/tela-principal.png)

## Features

- Online search across providers: **SubDL**, **OpenSubtitles**, and **SubSource**.
- Automatic subtitle-to-video sync (ALASS).
- Mux softsubs into the output container (FFmpeg/FFprobe).
- Processing queue with status, retries, and overall progress.
- **Single installer binary** (`syncora.exe`): the same file is the setup wizard and the app. It detects first-run vs. already-installed state via an `.installed` marker and a registry key.
- **Automatic update check** via GitHub Releases, with a 24h cache and a non-blocking toast when a new version is out.
- Explorer context menu integration:
  - **Open with Syncora**
  - **Download subtitles**
  - **Download subtitles and sync**

![Options](docs/screenshots/opcoes.png)

![Subtitle providers](docs/screenshots/provedores.png)

![Explorer context menu](docs/screenshots/menu-explorer.png)

## Installation (end user)

Download `syncora.exe` from the [releases page](https://github.com/CRaulD/Syncora/releases) and run it. The 4-step setup wizard handles:

1. **Terms of Use** — acceptance is required to continue.
2. **Prepare** — pick the install destination (default: `%LOCALAPPDATA%\Programs\Syncora`) and options (dependencies, Explorer menu).
3. **Install** — progress bar with current step and percentage.
4. **Finish** — launches the app.

Installation is **per-user** (HKCU + `%LOCALAPPDATA%`) — no UAC prompt. To uninstall, use "Uninstall Syncora" from the Start Menu, or Windows "Installed apps".

## Development requirements

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 18+ | Frontend build (Vite + React + TypeScript) |
| Rust | 1.77+ | Tauri build and Explorer helper |
| Python | 3.10+ | Backend packaging (FastAPI) via PyInstaller |

## Development

```powershell
npm install
npm run tauri:dev
```

The app boots the React UI and starts the Python backend automatically on port `8765`.

To run the backend manually:

```powershell
cd backend
py -m pip install -r requirements.txt
py -m uvicorn server:app --host 127.0.0.1 --port 8765 --reload
```

## Build

Build the single-binary installer (`syncora.exe` with the frontend and backend embedded, no NSIS/MSI installer):

```powershell
npm run build:syncora
```

Output: `src-tauri\target\release\syncora.exe` (~12 MB).

> The `tauri build --no-bundle` command is used to produce the single `.exe`. To generate traditional installers (`.msi` / NSIS `.exe`), use `npm run tauri:build`.

### Bundled backend

The Python backend is packaged with PyInstaller into `backend\dist\syncora-backend.exe` (~50 MB) and embedded as a Tauri resource. The full build (`build:syncora`) handles everything automatically.

## Subtitle providers

Providers are configured in the **Settings** tab of the app. Each one may require an **API key** (and optionally a username and password) and has its own usage limits:

- **SubDL** — API key required.
- **OpenSubtitles** — API key required; username and password optional for account validation and higher limits.
- **SubSource** — API key.

> Keys are stored locally on your machine and are never sent to any server other than the corresponding provider.

## Local data

Provider keys, downloaded dependencies (ALASS, FFmpeg, FFprobe), and app state are kept out of the repo, in:

```text
%LOCALAPPDATA%\Syncora\runtime
%LOCALAPPDATA%\app.syncora.desktop\         # Tauri local data (update checker cache, .installed, logs)
%APPDATA%\Syncora\                          # HKCU\Software\Syncora and HKCU\...\Uninstall\Syncora
```

## Updates

The app queries the GitHub Releases API (`api.github.com/repos/CRaulD/Syncora/releases/latest`) on startup (1.5s after load) and shows an amber toast in the bottom-right corner when a new version is available. The 24h cache avoids hitting GitHub's rate limit (60 req/hour for unauthenticated calls). You can force a fresh check in **Settings → Updates → Check now**.

For the update check to work correctly, the repository must have at least one published release (e.g. `v0.1.0-beta` for this version).

## Project layout

```
.
├── src/                  # React + Vite + TypeScript frontend
│   ├── components/       # Reusable components (SetupWizard, etc.)
│   ├── locales/          # i18n translations (pt-BR, en, es)
│   └── styles/           # CSS (App + installer)
├── src-tauri/            # Tauri app (Rust)
│   ├── src/              # lib.rs (app), setup_installer.rs (installer)
│   ├── icons/            # App icons
│   └── capabilities/     # Tauri permissions
├── backend/              # Python backend (FastAPI) + PyInstaller packaging
├── scripts/              # PowerShell scripts (build, Explorer context)
└── docs/                 # Legal docs, screenshots, plans
```

## License

MIT — see [LICENSE](LICENSE).

## Legal documents

- **Terms of Use** — [en](docs/terms/en.md) · [pt-BR](docs/terms/pt-BR.md) · [es](docs/terms/es.md)
- **Privacy Policy** — [en](docs/privacy/en.md) · [pt-BR](docs/privacy/pt-BR.md) · [es](docs/privacy/es.md)
