# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versioning follows [Semantic Versioning](https://semver.org/).

> 🌐 **Language:** **English** · [Português (BR)](CHANGELOG.pt-BR.md)

## [0.1.1-beta] - 2026-06-06

### Fixed (follow-up: uninstall + partial install state)
- **Uninstall now always cleans the registry**, even if the install folder is gone. Previously, if the install dir was removed (e.g. by antivirus or manually), the registry entries in `HKCU\Software\Syncora` and `HKCU\...\Uninstall\Syncora` were left orphaned, making the app appear installed in Windows Settings → Apps with no way to remove it (the `UninstallString` pointed to a non-existent `.exe`). `run_uninstall` now always removes the registry keys, the `.installed` marker, the runtime dir, the Desktop and Start Menu shortcuts, and the explorer integration — only the install dir removal is conditional on the registry value being present.
- **`is_installed()` now verifies the install folder actually exists**. Previously, the function returned `true` whenever the registry had an `InstallPath` entry, even if that path was gone — causing the main app to launch with a broken backend instead of the wizard. Now the wizard opens with a Repair option when the install is in this partial state.
- **"Abrir o Syncora" button on the install finish screen did nothing**. The setup() builder only ever created ONE window: the main window if the app was already installed, otherwise the setup wizard. After a fresh install finished, the main window was never created, so `launch_main_app()` called `main_win.show()` on a non-existent window and silently did nothing. `launch_main_app()` now creates the main window (and starts the backend) when it's missing.
- **Explorer integration status always reported "partial" even after a fresh install**. The `fs::write` of the SendTo shortcuts used `let _ = ...`, which silently swallowed permission errors. If the user had no write access to `%APPDATA%\Microsoft\Windows\SendTo`, the wrappers were created but the shortcuts weren't, and the status check (which looks at both) reported "partial" forever. The error is now logged, and the status message is specific to which part is missing (`missingShortcutsMessage` or `missingWrappersMessage`) instead of a generic "partial" string.
- **Explorer menu not installing during the wizard even when checked**. The helper `syncora-open.exe` is embedded inside the installer binary via `include_bytes!` and only written to the install dir during `copy_app_files`. But `current_helper_exe()` only looked for it next to the current executable (the installer, not the installed copy), so the helper was never found during the first install. Added `installed_path_from_registry()` which reads `HKCU\Software\Syncora\InstallPath` (set by `mark_as_installed` before the explorer install runs) and checks for the helper there as the final fallback.

### Added (follow-up: repair option in wizard)
- **"Repair installation" option in the setup wizard**. When the registry has an `InstallPath` but the folder is missing, the wizard now shows a dedicated screen with the registered path and two buttons: **Reparar** (re-install to the same path, re-download all deps) and **Instalação nova** (proceed with the normal fresh-install flow). The Repair screen is translated in pt-BR, en, and es.
- **`get_install_state` Tauri command** that returns `fresh`, `partial { path }`, or `complete`, so the wizard can detect the partial state and offer the right action.
- **Explorer integration status messages are now localized** in pt-BR, en, and es (previously hardcoded in PT-BR).



### Fixed
- **Critical bug in `v0.1.0-beta`**: the installer never copied `syncora-backend.exe`, `syncora-open.exe`, or the icons to the install folder. The setup wizard finished successfully, but on first launch the app reported "Backend offline" because the backend, helper, and icons were never installed. The new build embeds them inside `syncora.exe` via `include_bytes!` and writes them to the install folder at install time, so they are guaranteed to be present.

### Added
- **Single-binary embed** of the backend, Explorer helper, and all icon assets. `syncora.exe` no longer depends on `bundle.resources` being present at the right path; everything ships inside the binary.
- **Install-time download** of the two external dependencies, with graceful fallback if the network is offline:
  - **ALASS** (subtitle resync CLI, ~26 MB) from `github.com/kaegi/alass/releases/download/v2.0.0/alass-windows64.zip`.
  - **FFmpeg + FFprobe** (~88 MB) from `github.com/BtbN/FFmpeg-Builds/releases/latest/ffmpeg-master-latest-win64-lgpl-shared.zip`.
  - Both are downloaded straight to `%LOCALAPPDATA%\Syncora\runtime\` and a `manifest.json` is written so the app can detect and update them later.
- **10-step install progress** with byte-level download progress (e.g. "13 MB / 26 MB") so the wizard no longer looks stuck during large downloads. All step labels are translated in pt-BR, en, and es.
- **Reinstall safety**: `run_install` now kills any running `syncora`, `syncora-backend`, or `syncora-open` process before overwriting files, eliminating `os error 32` when the user retries the install with the previous build still open.
- **Manifest** in `%LOCALAPPDATA%\Syncora\runtime\manifest.json` records the version, installed path, and installer for each dep.

### Changed
- **Build script** (`npm run build:syncora`) now builds the Rust helper (`syncora-open.exe`) before the main `tauri build` so `include_bytes!("../target/release/syncora-open.exe")` resolves at compile time.
- **Uninstall** now also removes `%LOCALAPPDATA%\Syncora\runtime\` (the downloaded ALASS + FFmpeg + manifest), keeping no leftover files on disk.
- **Backend discovery**: `find_backend_exe` now tries `exe_dir/backend/syncora-backend.exe` first, so the embedded install layout is found without any environment tweaks.

### Fixed
- **Explorer "Remover" button always disabled**: the `disabled` condition was checking for a non-existent `"uninstall"` busy state, so the button was never clickable. It now correctly checks `explorerBusy !== "idle"` and works as intended.
- **Install progress stuck on download**: the previous 4-step flow had no per-byte updates during downloads, making the bar look frozen; the new flow emits 64 KB chunked progress.

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
