# Privacy Policy — Syncora

> How Syncora handles your data. Last updated: June 2026 — version 0.1.0.

## Summary

- ✅ Everything is **local** — keys and preferences stay on your PC
- ✅ No **telemetry** is sent to the developers
- ✅ Your credentials go **directly** to the provider (SubDL, OpenSubtitles, SubSource)
- ⚠️ You are responsible for respecting each provider's terms

## 1. Data stored locally

Syncora saves **on your computer** (in `%LOCALAPPDATA%\Syncora\`):

| Data | Where | Why |
|---|---|---|
| Provider API keys | `%LOCALAPPDATA%\Syncora\config\*.json` | To authenticate with configured services |
| Username/password (optional) | Same location, in a separate file | To validate your account with providers that require it |
| App preferences | Same location | Theme, download options, queue |
| Subtitle cache | `%LOCALAPPDATA%\Syncora\runtime\` | Avoid re-downloads and speed up retries |
| Downloaded dependencies (ALASS, FFmpeg) | `%LOCALAPPDATA%\Syncora\runtime\` | To work offline after the first run |

These files **never leave your PC** unless you share them yourself. You can delete them at any time by uninstalling the app or removing the `%LOCALAPPDATA%\Syncora\` folder.

## 2. Data sent to third parties

Syncora **does not send data to the developers**. It communicates **directly** with the providers you have configured, **only when you use the corresponding feature**.

### SubDL
- **Sent**: API key (header `Api-Key` / `X-API-Key`) + file/movie name searched + language
- **Purpose**: search and download subtitles

### OpenSubtitles
- **Sent**: API key + (optional) username and password for login + file name + language
- **Purpose**: authenticate, search, and download subtitles
- **Session token**: saved locally after login; revocable at any time from your provider account

### SubSource
- **Sent**: API key + search parameters
- **Purpose**: search and download subtitles

> Each provider has its **own privacy policy**. We recommend reading the provider's terms before configuring an account.

## 3. Telemetry

**Syncora does not collect telemetry, usage metrics, analytics, or any behavioral data.**

There is no:

- Usage tracking (which features you use, how often)
- Remote error reporting
- "Phone home" with statistics
- Cookies or unique identifiers

## 4. External dependencies

On first run (or when you download dependencies from the app), Syncora downloads binaries from:

- **ALASS** — official repository
- **FFmpeg / FFprobe** — official sites/builds

These downloads use direct HTTPS, with no proxy or relay. The exact addresses are in the open source code and can be audited.

## 5. Windows permissions

The Syncora installer may ask to:

- Create shortcuts (Start menu / desktop)
- Add entries to the Explorer context menu (right-click on video files)
- Create files in `%LOCALAPPDATA%\Syncora\`

The app **does not** request:

- Administrator permissions (installs under `LocalAppData`)
- Internet access outside the configured provider
- Access to data outside the runtime folder

The Explorer menu integration is **optional** — you choose it at install time (or you can install/remove it later from the app itself).

## 6. Uninstallation

When you uninstall Syncora:

- The app, shortcuts, and Explorer helper are removed
- The context menu integration is removed automatically
- **Local data (`%LOCALAPPDATA%\Syncora\`) is NOT removed by default** — delete it manually if you want a full cleanup

## 7. Minors

Syncora is not intended for minors under 13. Use by minors must be supervised by a guardian, who must ensure compliance with local laws and with the providers' terms.

## 8. Changes to this policy

This policy may be updated. Material changes will come with new Syncora versions. The current version of this document is shown at the top.

## 9. Contact

Privacy questions? Open an issue at [github.com/CRaulD/Syncora/issues](https://github.com/CRaulD/Syncora/issues).
