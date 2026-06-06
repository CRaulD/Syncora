// src-tauri/src/setup_installer.rs
// Instalador de primeiro uso (Tauri single-binary).
// Detecta HKCU\Software\Syncora\InstallPath para decidir setup vs app.
// Reaproveita a logica de integracao com o Explorer ja existente em lib.rs
// (multi-idioma, HKCU, sem UAC) em vez de duplicar com HKLM/HKCR.

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const REG_HKCU_BASE: &str = r"Software\Syncora";
const REG_INSTALL_PATH: &str = "InstallPath";
const REG_VERSION: &str = "Version";
const REG_INSTALL_DATE: &str = "InstallDate";
const REG_UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Syncora";

const DEFAULT_INSTALL_DIR: &str = "Syncora";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

// Resources embedded into the binary at compile time.
// These replace the old `bundle.resources` approach and make `syncora.exe`
// truly self-contained. The install wizard extracts them to the install dir.
const BACKEND_EXE_BYTES: &[u8] =
    include_bytes!("../../backend/dist/syncora-backend.exe");
const HELPER_EXE_BYTES: &[u8] =
    include_bytes!("../target/release/syncora-open.exe");
const ICON_ICO_BYTES: &[u8] = include_bytes!("../icons/icon.ico");
const ICON_32_BYTES: &[u8] = include_bytes!("../icons/32x32.png");
const ICON_128_BYTES: &[u8] = include_bytes!("../icons/128x128.png");
const ICON_128_2X_BYTES: &[u8] = include_bytes!("../icons/128x128@2x.png");

const RUNTIME_DIR_NAME: &str = "Syncora";
const RUNTIME_SUBDIR: &str = "runtime";
const HTTP_TIMEOUT_SECS: u64 = 30;
const DOWNLOAD_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Deserialize, Clone)]
pub struct InstallOptions {
    #[serde(rename = "installDeps")]
    pub install_deps: bool,
    #[serde(rename = "installExplorer")]
    pub install_explorer: bool,
    #[serde(rename = "installPath")]
    pub install_path: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct InstallProgress {
    pub step: String,
    pub step_key: Option<String>,
    pub pct: u8,
    pub done: bool,
    pub error: Option<String>,
    pub detail: Option<String>,
}

impl InstallProgress {
    #[allow(dead_code)]
    fn emit(
        app: &AppHandle,
        step: &str,
        pct: u8,
        done: bool,
        error: Option<String>,
        detail: Option<String>,
    ) {
        Self::emit_keyed(app, step, None, pct, done, error, detail);
    }

    fn emit_keyed(
        app: &AppHandle,
        step: &str,
        step_key: Option<&str>,
        pct: u8,
        done: bool,
        error: Option<String>,
        detail: Option<String>,
    ) {
        let _ = app.emit(
            "install-progress",
            InstallProgress {
                step: step.to_string(),
                step_key: step_key.map(str::to_string),
                pct,
                done,
                error,
                detail,
            },
        );
    }
}

pub fn default_install_path() -> PathBuf {
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data)
            .join("Programs")
            .join(DEFAULT_INSTALL_DIR);
    }
    if let Some(home) = dirs::home_dir() {
        return home
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join(DEFAULT_INSTALL_DIR);
    }
    PathBuf::from("C:\\Syncora")
}

pub fn is_installed(app: &AppHandle) -> bool {
    if let Ok(key) = app
        .path()
        .app_local_data_dir()
        .map(|d| d.join(".installed"))
    {
        if key.is_file() {
            return true;
        }
    }

    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(sub) = hkcu.open_subkey(REG_HKCU_BASE) {
            if sub.get_value::<String, _>(REG_INSTALL_PATH).is_ok() {
                return true;
            }
        }
    }

    false
}

#[tauri::command]
pub async fn start_install(app: AppHandle, opts: InstallOptions) -> Result<(), String> {
    let app_clone = app.clone();
    let opts_clone = opts.clone();

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = run_install(&app_clone, &opts_clone) {
            let msg = e.to_string();
            log::error!("Falha na instalacao: {msg}");
            InstallProgress::emit_keyed(
                &app_clone,
                "Erro na instalacao",
                Some("installer.progressSteps.error"),
                0,
                true,
                Some(msg),
                None,
            );
        }
    });

    Ok(())
}

fn run_install(app: &AppHandle, opts: &InstallOptions) -> Result<(), Box<dyn std::error::Error>> {
    let install_path = PathBuf::from(&opts.install_path);

    if install_path.as_os_str().is_empty() {
        return Err("Caminho de instalacao vazio.".into());
    }

    kill_running_syncora();

    InstallProgress::emit_keyed(
        app,
        "Validando caminho de instalacao...",
        Some("installer.progressSteps.validating"),
        5,
        false,
        None,
        None,
    );
    validate_install_path_inner(&install_path)
        .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

    InstallProgress::emit_keyed(
        app,
        "Criando pasta de instalacao...",
        Some("installer.progressSteps.creatingDir"),
        10,
        false,
        None,
        None,
    );
    fs::create_dir_all(&install_path)?;

    InstallProgress::emit_keyed(
        app,
        "Copiando arquivos...",
        Some("installer.progressSteps.copyingFiles"),
        18,
        false,
        None,
        None,
    );
    copy_app_files(app, &install_path)?;

    if opts.install_deps {
        let app_for_alass = app.clone();
        match install_alass(|step, step_key, pct, detail| {
            InstallProgress::emit_keyed(
                &app_for_alass,
                step,
                Some(step_key),
                pct,
                false,
                None,
                detail.map(str::to_string),
            );
        }) {
            Ok(_) => {
                InstallProgress::emit_keyed(
                    app,
                    "Extraindo ALASS...",
                    Some("installer.progressSteps.extractingAlass"),
                    40,
                    false,
                    None,
                    None,
                );
            }
            Err(e) => {
                log::warn!("Falha ao instalar ALASS: {e}");
                InstallProgress::emit_keyed(
                    app,
                    "ALASS sera baixado no primeiro uso",
                    Some("installer.progressSteps.alassDeferred"),
                    40,
                    false,
                    None,
                    Some(e),
                );
            }
        }

        let app_for_ffmpeg = app.clone();
        match install_ffmpeg(|step, step_key, pct, detail| {
            InstallProgress::emit_keyed(
                &app_for_ffmpeg,
                step,
                Some(step_key),
                pct,
                false,
                None,
                detail.map(str::to_string),
            );
        }) {
            Ok(_) => {
                InstallProgress::emit_keyed(
                    app,
                    "Extraindo FFmpeg...",
                    Some("installer.progressSteps.extractingFfmpeg"),
                    85,
                    false,
                    None,
                    None,
                );
            }
            Err(e) => {
                log::warn!("Falha ao instalar FFmpeg: {e}");
                InstallProgress::emit_keyed(
                    app,
                    "FFmpeg sera baixado no primeiro uso",
                    Some("installer.progressSteps.ffmpegDeferred"),
                    85,
                    false,
                    None,
                    Some(e),
                );
            }
        }
    }

    InstallProgress::emit_keyed(
        app,
        "Criando atalhos...",
        Some("installer.progressSteps.creatingShortcuts"),
        90,
        false,
        None,
        None,
    );
    create_shortcuts(&install_path)?;

    InstallProgress::emit_keyed(
        app,
        "Registrando no sistema...",
        Some("installer.progressSteps.registering"),
        95,
        false,
        None,
        None,
    );
    register_uninstaller(&install_path)?;
    mark_as_installed(app, &install_path)?;

    if opts.install_explorer {
        InstallProgress::emit_keyed(
            app,
            "Instalando menu do Explorer...",
            Some("installer.progressSteps.installingExplorer"),
            98,
            false,
            None,
            None,
        );
        if let Err(e) = super::install_explorer_integration_native() {
            log::warn!("Falha na integracao com Explorer: {e}");
        }
    }

    InstallProgress::emit_keyed(
        app,
        "Concluido!",
        Some("installer.progressSteps.completed"),
        100,
        true,
        None,
        None,
    );
    Ok(())
}

fn copy_app_files(app: &AppHandle, dest: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let _ = app;
    let exe_path = std::env::current_exe()?;
    let exe_dest = dest.join("Syncora.exe");
    fs::copy(&exe_path, &exe_dest).map_err(|e| format!("Falha ao copiar Syncora.exe: {e}"))?;

    let helper_dest = dest.join("syncora-open.exe");
    write_bytes(&helper_dest, HELPER_EXE_BYTES)
        .map_err(|e| format!("Falha ao extrair syncora-open.exe: {e}"))?;

    let backend_dest_dir = dest.join("backend");
    fs::create_dir_all(&backend_dest_dir)?;
    let backend_dest = backend_dest_dir.join("syncora-backend.exe");
    write_bytes(&backend_dest, BACKEND_EXE_BYTES)
        .map_err(|e| format!("Falha ao extrair syncora-backend.exe: {e}"))?;

    let icons_dest_dir = dest.join("icons");
    fs::create_dir_all(&icons_dest_dir)?;
    write_bytes(&icons_dest_dir.join("icon.ico"), ICON_ICO_BYTES)?;
    write_bytes(&icons_dest_dir.join("32x32.png"), ICON_32_BYTES)?;
    write_bytes(&icons_dest_dir.join("128x128.png"), ICON_128_BYTES)?;
    write_bytes(
        &icons_dest_dir.join("128x128@2x.png"),
        ICON_128_2X_BYTES,
    )?;

    Ok(())
}

fn write_bytes(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(dest, bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(())
}

fn runtime_base_dir() -> Option<PathBuf> {
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        return Some(PathBuf::from(local_app_data).join(RUNTIME_DIR_NAME));
    }
    if let Some(home) = dirs::home_dir() {
        return Some(home.join("AppData").join("Local").join(RUNTIME_DIR_NAME));
    }
    None
}

fn runtime_dir() -> Option<PathBuf> {
    runtime_base_dir().map(|p| p.join(RUNTIME_SUBDIR))
}

fn read_manifest() -> serde_json::Value {
    let Some(rd) = runtime_dir() else {
        return json!({});
    };
    let path = rd.join("manifest.json");
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_manifest(manifest: &serde_json::Value) -> Result<(), String> {
    let Some(rd) = runtime_dir() else {
        return Err("LOCALAPPDATA nao definido".into());
    };
    fs::create_dir_all(&rd).map_err(|e| format!("mkdir runtime: {e}"))?;
    let path = rd.join("manifest.json");
    let text = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("serialize manifest: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("write manifest: {e}"))?;
    Ok(())
}

fn kill_running_syncora() {
    #[cfg(target_os = "windows")]
    {
        let script = "Get-Process -Name 'syncora','syncora-backend','syncora-open' -ErrorAction SilentlyContinue | Stop-Process -Force";
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.output();
    }
    std::thread::sleep(Duration::from_millis(800));
}

fn download_with_progress<F>(url: &str, dest: &Path, on_progress: F) -> Result<u64, String>
where
    F: Fn(u64, Option<u64>),
{
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .user_agent(concat!("Syncora/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "GET {url}: HTTP {}",
            response.status().as_u16()
        ));
    }
    let total = response.content_length();

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let mut file = fs::File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;

    let mut received: u64 = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = response
            .read(&mut buffer)
            .map_err(|e| format!("read body: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n])
            .map_err(|e| format!("write body: {e}"))?;
        received += n as u64;
        on_progress(received, total);
    }
    file.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(received)
}

fn fetch_release_info(api_url: &str) -> Result<(String, Vec<serde_json::Value>), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent(concat!("Syncora/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let response = client
        .get(api_url)
        .send()
        .map_err(|e| format!("GET {api_url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "GET {api_url}: HTTP {}",
            response.status().as_u16()
        ));
    }
    let json: serde_json::Value = response
        .json()
        .map_err(|e| format!("decode release json: {e}"))?;
    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let assets = json
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok((tag, assets))
}

fn pick_asset(assets: &[serde_json::Value], name_predicate: &dyn Fn(&str) -> bool) -> Option<String> {
    for asset in assets {
        let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name_predicate(name) {
            if let Some(url) = asset.get("browser_download_url").and_then(|v| v.as_str()) {
                return Some(url.to_string());
            }
        }
    }
    None
}

fn install_alass<F>(on_step: F) -> Result<(), String>
where
    F: Fn(&str, &str, u8, Option<&str>),
{
    let (tag, assets) = fetch_release_info(
        "https://api.github.com/repos/kaegi/alass/releases/latest",
    )?;
    let url = pick_asset(&assets, &|name| {
        let lower = name.to_ascii_lowercase();
        lower.contains("windows64") && lower.ends_with(".zip")
    })
    .ok_or_else(|| "Asset windows64.zip do ALASS nao encontrado".to_string())?;

    let Some(rd) = runtime_dir() else {
        return Err("LOCALAPPDATA nao definido".into());
    };
    let out_dir = rd.join("alass");
    fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir alass: {e}"))?;

    let tmp = std::env::temp_dir().join(format!("syncora-alass-{}.zip", std::process::id()));
    let bytes = download_with_progress(&url, &tmp, |received, total| {
        let mib_received = received / (1024 * 1024);
        let mib_total = total.map(|t| t / (1024 * 1024));
        on_step(
            "Baixando ALASS",
            "installer.progressSteps.downloadingAlass",
            35,
            Some(&format!("{} MB / {} MB", mib_received, mib_total.unwrap_or(0))),
        );
    })?;
    log::info!("ALASS zip baixado: {} bytes", bytes);

    let file = fs::File::open(&tmp).map_err(|e| format!("open zip: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("ler zip: {e}"))?;
    let mut extracted_path: Option<PathBuf> = None;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("entry {i}: {e}"))?;
        let name = entry.name().to_ascii_lowercase();
        if name.ends_with("alass-cli.exe") || name.ends_with("alass.exe") {
            let dest = out_dir.join("alass-cli.exe");
            let mut out = fs::File::create(&dest).map_err(|e| format!("create alass-cli: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("copy alass-cli: {e}"))?;
            extracted_path = Some(dest);
            break;
        }
    }
    let _ = fs::remove_file(&tmp);
    let Some(exe) = extracted_path else {
        return Err("alass-cli.exe nao encontrado no zip".into());
    };
    log::info!("ALASS extraido para {}", exe.display());

    let mut manifest = read_manifest();
    manifest["alass"] = json!({
        "version": tag,
        "path": exe.to_string_lossy(),
        "installed_by": "installer",
    });
    write_manifest(&manifest)?;
    Ok(())
}

fn install_ffmpeg<F>(on_step: F) -> Result<(), String>
where
    F: Fn(&str, &str, u8, Option<&str>),
{
    let (tag, assets) = fetch_release_info(
        "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest",
    )?;
    let url = pick_asset(&assets, &|name| {
        let lower = name.to_ascii_lowercase();
        lower.contains("win64")
            && lower.contains("lgpl-shared")
            && lower.ends_with(".zip")
    })
    .ok_or_else(|| "Asset win64-lgpl-shared.zip do FFmpeg nao encontrado".to_string())?;

    let Some(rd) = runtime_dir() else {
        return Err("LOCALAPPDATA nao definido".into());
    };
    let out_dir = rd.join("ffmpeg");
    fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir ffmpeg: {e}"))?;

    let tmp = std::env::temp_dir().join(format!("syncora-ffmpeg-{}.zip", std::process::id()));
    let bytes = download_with_progress(&url, &tmp, |received, total| {
        let mib_received = received / (1024 * 1024);
        let mib_total = total.map(|t| t / (1024 * 1024));
        on_step(
            "Baixando FFmpeg",
            "installer.progressSteps.downloadingFfmpeg",
            60,
            Some(&format!("{} MB / {} MB", mib_received, mib_total.unwrap_or(0))),
        );
    })?;
    log::info!("FFmpeg zip baixado: {} bytes", bytes);

    let file = fs::File::open(&tmp).map_err(|e| format!("open zip: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("ler zip: {e}"))?;
    let mut ffmpeg_ok = false;
    let mut ffprobe_ok = false;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("entry {i}: {e}"))?;
        let raw_name = entry.name().replace('\\', "/");
        if !raw_name.to_ascii_lowercase().contains("/bin/") {
            continue;
        }
        let filename = Path::new(&raw_name)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        if !filename.ends_with(".exe") && !filename.ends_with(".dll") {
            continue;
        }
        let dest = out_dir.join(&filename);
        let mut out = fs::File::create(&dest).map_err(|e| format!("create {filename}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("copy {filename}: {e}"))?;
        if filename.eq_ignore_ascii_case("ffmpeg.exe") {
            ffmpeg_ok = true;
        }
        if filename.eq_ignore_ascii_case("ffprobe.exe") {
            ffprobe_ok = true;
        }
    }
    let _ = fs::remove_file(&tmp);
    if !ffmpeg_ok || !ffprobe_ok {
        return Err("ffmpeg/ffprobe nao encontrados no zip".into());
    }
    log::info!("FFmpeg extraido em {}", out_dir.display());

    let mut manifest = read_manifest();
    manifest["ffmpeg"] = json!({
        "version": tag,
        "path": out_dir.join("ffmpeg.exe").to_string_lossy(),
        "installed_by": "installer",
    });
    write_manifest(&manifest)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn create_shortcuts(install_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let exe = install_path.join("Syncora.exe");
    let exe_str = exe.to_string_lossy().to_string();
    let icon_path = install_path.join("icons").join("icon.ico");
    let icon_str = if icon_path.is_file() {
        icon_path.to_string_lossy().to_string()
    } else {
        install_path
            .join("icon.ico")
            .to_string_lossy()
            .to_string()
    };

    if let Some(desktop) = dirs::desktop_dir() {
        let shortcut = desktop.join("Syncora.lnk");
        let ps = build_shortcut_script(&shortcut, &exe_str, install_path, &icon_str);
        run_powershell(&ps)?;
    }

    if let Some(start_menu) = dirs::data_dir().map(|d| {
        d.join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
    }) {
        let sm_dir = start_menu.join("Syncora");
        fs::create_dir_all(&sm_dir)?;
        let shortcut = sm_dir.join("Syncora.lnk");
        let ps = build_shortcut_script(&shortcut, &exe_str, install_path, &icon_str);
        run_powershell(&ps)?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn build_shortcut_script(shortcut: &Path, exe: &str, workdir: &Path, icon: &str) -> String {
    format!(
        r#"$s=(New-Object -COM WScript.Shell).CreateShortcut('{lnk}'); $s.TargetPath='{exe}'; $s.WorkingDirectory='{dir}'; $s.IconLocation='{ico},0'; $s.Description='Syncora'; $s.Save()"#,
        lnk = shortcut.to_string_lossy().replace('\'', "''"),
        exe = exe.replace('\'', "''"),
        dir = workdir.to_string_lossy().replace('\'', "''"),
        ico = icon.replace('\'', "''"),
    )
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("PowerShell falhou: {stderr}").into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn create_shortcuts(_install_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn register_uninstaller(install_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    let (uninst_key, _) = hkcu.create_subkey(REG_UNINSTALL_KEY)?;
    let exe_path = install_path.join("Syncora.exe");
    let display_icon = if install_path.join("icons").join("icon.ico").is_file() {
        format!("{}\\,0", install_path.join("icons").join("icon.ico").display())
    } else {
        format!("{},0", exe_path.display())
    };

    uninst_key.set_value("DisplayName", &"Syncora")?;
    uninst_key.set_value("DisplayVersion", &APP_VERSION)?;
    uninst_key.set_value("Publisher", &"Syncora Contributors")?;
    uninst_key.set_value("DisplayIcon", &display_icon)?;
    uninst_key.set_value("InstallLocation", &format!("{}", install_path.display()))?;
    uninst_key.set_value("UninstallString", &format!("\"{}\" --uninstall", exe_path.display()))?;
    uninst_key.set_value("NoModify", &1u32)?;
    uninst_key.set_value("NoRepair", &1u32)?;
    uninst_key.set_value("URLInfoAbout", &"https://github.com/CRaulD/Syncora")?;

    let (syncora_key, _) = hkcu.create_subkey(REG_HKCU_BASE)?;
    syncora_key.set_value(REG_INSTALL_PATH, &format!("{}", install_path.display()))?;
    syncora_key.set_value(REG_VERSION, &APP_VERSION)?;

    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    syncora_key.set_value(REG_INSTALL_DATE, &epoch)?;

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn register_uninstaller(_install_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

fn mark_as_installed(app: &AppHandle, install_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(local_data) = app.path().app_local_data_dir() {
        fs::create_dir_all(&local_data)?;
        fs::write(local_data.join(".installed"), APP_VERSION)?;
    }
    let _ = install_path;
    Ok(())
}

#[tauri::command]
pub async fn launch_main_app(app: AppHandle) -> Result<(), String> {
    if let Some(setup_win) = app.get_webview_window("setup") {
        let _ = setup_win.close();
    }
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.show();
        let _ = main_win.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn get_default_install_path() -> String {
    default_install_path().to_string_lossy().to_string()
}

fn validate_install_path_inner(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("Caminho de instalação vazio.".into());
    }

    if !path.is_absolute() {
        return Err(format!(
            "Caminho deve ser absoluto (ex.: C:\\Programas\\Syncora): {}",
            path.display()
        ));
    }

    let path_str = path.to_string_lossy();
    for ch in ['<', '>', '"', '|', '?', '*'] {
        if path_str.chars().any(|c| c == ch) {
            return Err(format!(
                "Caminho contém caractere inválido '{}': {}",
                ch,
                path.display()
            ));
        }
    }

    if path_str.chars().any(|c| (c as u32) < 0x20) {
        return Err("Caminho contém caracteres de controle inválidos.".into());
    }

    if path_str.len() > 200 {
        return Err(format!(
            "Caminho muito longo ({} caracteres). Use um caminho mais curto (máx. 200).",
            path_str.len()
        ));
    }

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Caminho inválido: sem diretório pai.".to_string())?;
    if !parent.is_dir() {
        return Err(format!(
            "Diretório pai não existe: {}",
            parent.display()
        ));
    }

    let path_lower = path_str.to_lowercase();
    let forbidden = [
        r"c:\windows",
        r"c:\windows\system32",
        r"c:\windows\syswow64",
        r"c:\program files",
        r"c:\program files (x86)",
        r"c:\programdata",
        r"c:\system volume information",
        r"c:\$recycle.bin",
    ];
    for prefix in &forbidden {
        if path_lower.starts_with(prefix) {
            return Err(format!(
                "Não é permitido instalar em pasta do sistema: {}",
                path.display()
            ));
        }
    }

    fs::create_dir_all(path).map_err(|e| {
        format!(
            "Não foi possível criar a pasta '{}': {}",
            path.display(),
            e
        )
    })?;

    let probe = path.join(".syncora-write-test");
    if let Err(e) = fs::write(&probe, b"ok") {
        let _ = fs::remove_file(&probe);
        return Err(format!(
            "Sem permissão de escrita em '{}': {}",
            path.display(),
            e
        ));
    }
    let _ = fs::remove_file(&probe);

    Ok(())
}

#[tauri::command]
pub fn validate_install_path(install_path: String) -> Result<(), String> {
    validate_install_path_inner(&PathBuf::from(&install_path))
}

pub fn run_uninstall() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu_root = RegKey::predef(HKEY_CURRENT_USER);
        let install_path: Option<PathBuf> = hkcu_root
            .open_subkey(REG_HKCU_BASE)
            .ok()
            .and_then(|key| key.get_value::<String, _>(REG_INSTALL_PATH).ok())
            .map(PathBuf::from);

        match &install_path {
            Some(path) => {
                log::info!("Desinstalando de: {}", path.display());
                super::uninstall_explorer_integration_native();
                let _ = fs::remove_dir_all(path);
            }
            None => {
                log::warn!("InstallPath nao encontrado no registro. Limpando orfaos.");
                super::uninstall_explorer_integration_native();
            }
        }

        if let Some(local) = dirs::data_local_dir() {
            let _ = fs::remove_file(local.join("app.syncora.desktop").join(".installed"));
        }

        let _ = hkcu_root.delete_subkey_all(REG_UNINSTALL_KEY);
        let _ = hkcu_root.delete_subkey_all(REG_HKCU_BASE);

        if let Some(runtime) = runtime_base_dir() {
            let _ = fs::remove_dir_all(&runtime);
        }

        if let Some(desktop) = dirs::desktop_dir() {
            let _ = fs::remove_file(desktop.join("Syncora.lnk"));
        }
        if let Some(appdata) = dirs::data_dir() {
            let start_menu = appdata
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Syncora");
            let _ = fs::remove_dir_all(&start_menu);
        }

        log::info!("Desinstalacao concluida.");
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn read_install_path_from_registry() -> Option<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey(REG_HKCU_BASE)
        .ok()
        .and_then(|k| k.get_value::<String, _>(REG_INSTALL_PATH).ok())
        .map(PathBuf::from)
}

#[cfg(target_os = "windows")]
fn build_uninstall_powershell_script(install_path: &Path, local_data: &Path) -> String {
    let path = install_path.to_string_lossy().replace('\'', "''");
    let local = local_data.to_string_lossy().replace('\'', "''");
    let runtime = runtime_base_dir()
        .map(|p| p.to_string_lossy().replace('\'', "''").to_string())
        .unwrap_or_else(|| r"%LOCALAPPDATA%\Syncora".to_string());
    format!(
        r#"
        Start-Sleep -Seconds 2
        Get-Process -Name 'syncora' -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 1
        $ErrorActionPreference = 'SilentlyContinue'
        Remove-Item -LiteralPath '{path}' -Recurse -Force
        Remove-Item -LiteralPath '{local}\.installed' -Force
        Remove-Item -LiteralPath '{runtime}' -Recurse -Force
        Remove-Item -LiteralPath 'HKCU:\Software\Syncora' -Recurse -Force
        Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Syncora' -Recurse -Force
        $desktop = [Environment]::GetFolderPath('Desktop')
        Remove-Item -LiteralPath "$desktop\Syncora.lnk" -Force
        $startMenu = [Environment]::GetFolderPath('ApplicationData') + '\Microsoft\Windows\Start Menu\Programs\Syncora'
        Remove-Item -LiteralPath $startMenu -Recurse -Force
        "#,
        path = path,
        local = local,
        runtime = runtime,
    )
}

pub fn handle_uninstall_cli() -> bool {
    if !env::args().any(|arg| arg == "--uninstall" || arg == "/uninstall") {
        return false;
    }

    log::info!("Desinstalacao iniciada via CLI.");

    #[cfg(target_os = "windows")]
    {
        let install_path = read_install_path_from_registry();
        let local_data = dirs::data_local_dir().map(|p| p.join("app.syncora.desktop"));

        if let (Some(path), Some(local)) = (install_path, local_data) {
            let script = build_uninstall_powershell_script(&path, &local);
            let mut cmd = Command::new("powershell");
            cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script]);
            cmd.creation_flags(CREATE_NO_WINDOW);
            match cmd.spawn() {
                Ok(_) => log::info!("Cleanup PowerShell iniciado."),
                Err(e) => {
                    log::error!("Falha ao iniciar PowerShell: {e}. Fallback inline.");
                    let _ = run_uninstall();
                }
            }
        } else {
            log::warn!("Registry/local data dir nao encontrados. Fallback inline.");
            let _ = run_uninstall();
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = run_uninstall();
    }

    std::process::exit(0);
}
