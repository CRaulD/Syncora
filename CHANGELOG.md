# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versioning follows [Semantic Versioning](https://semver.org/).

> 🌐 **Language:** **English** · [Português (BR)](CHANGELOG.pt-BR.md)

## [0.1.0-beta] - 2026-06-06

### Added
- **Single Tauri binary (`syncora.exe`)** that replaces the previous Inno Setup installer. The same file is the setup wizard and the main app; it detects first-run state via an `.installed` marker in `%LOCALAPPDATA%\app.syncora.desktop\`.
- **4-step setup wizard**: Terms of Use (acceptance required), Prepare (path + options), Install (progress with step and percentage), and Finish (launches the app).
- **Path validation** before installing (length, invalid characters, system folders, write permission, parent existence).
- **Per-user installation** (HKCU + `%LOCALAPPDATA%\Programs\Syncora` by default) with no UAC prompt, plus Desktop and Start Menu shortcuts.
- **Robust uninstall** via `syncora.exe --uninstall` (registered in Add/Remove Programs): spawns a hidden PowerShell that kills running processes and removes the install folder, `.installed` marker, registry keys, and shortcuts.
- **Built-in update checker** that hits `api.github.com/repos/CRaulD/Syncora/releases/latest` on startup (1.5s delay) and on manual check. 24h cache respects GitHub's rate limit (60 req/h).
- **Non-blocking amber toast** in the bottom-right corner when an update is available, with a "Download" button that opens the release page in the browser.
- **"Updates" section** in the Settings tab with the current version, last-check timestamp, and a "Check now" button.
- **Full i18n** in **pt-BR**, **en**, and **es** for the installer, wizard, main app, and update messages.
- **App icons** now included as Tauri resources (`icons/` in `bundle.resources`), copied to the install folder and used for shortcuts and the registry.
- **Explorer context helper** (`syncora-open.exe`) packaged and installed, with a 3-language menu (PT/EN/ES) installed by default in HKCU.

### Changed
- **Cargo package identifier** renamed from `app` to `syncora`, and the binary from `app.exe` to `syncora.exe` to match the `productName`.
- **Build script** updated: `npm run build:syncora` now uses `tauri build --no-bundle` to produce the single `.exe` with frontend and backend embedded.
- **Added `shell:default` capability** to allow opening external URLs (GitHub release page).
- **`tauri.conf.json`**: `windows: []` (windows are created in code based on install state) and `icons/` in `bundle.resources`.

### Removed
- `scripts/generate-nsis-assets.mjs` (NSIS bitmap generator).
- `src-tauri/installer/syncora-inno.iss` (Inno Setup script).
- `src-tauri/installer/syncora-installer.nsi` (NSIS template).
- `src-tauri/installer/nsis-header.bmp` and `nsis-sidebar.bmp` (NSIS bitmaps).
- `docs/installer-tauri-plan.md` (original plan, superseded by the implementation).
- `npm run inno:build` command (replaced by `build:syncora`).

### Fixed
- **Build file lock**: `cargo` failed with `os error 32` when `syncora.exe` was still running; the build now embeds resources correctly.
- **Incomplete uninstall**: the old installer left the `.installed` marker and install folder behind after `fs::remove_dir_all` failed on in-use files; the new version kills processes before removing.
- **Shortcut icons**: icons were not copied to the install folder because they weren't in `bundle.resources`; they are now included and used by the `.lnk` `IconLocation` and the registry `DisplayIcon`.

### Security
- **Verified uninstaller**: spawns PowerShell with `CREATE_NO_WINDOW` (no visible window) and `-NoProfile -ExecutionPolicy Bypass`.
- **Path validation** against list-prefix of protected folders (`C:\Windows`, `C:\Program Files`, `C:\ProgramData`, etc.).

[0.1.0-beta]: https://github.com/CRaulD/Syncora/releases/tag/v0.1.0-beta
