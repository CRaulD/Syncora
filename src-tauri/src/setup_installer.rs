// src-tauri/src/setup_installer.rs
// Instalador de primeiro uso (Tauri single-binary).
// Detecta HKCU\Software\Syncora\InstallPath para decidir setup vs app.
// Reaproveita a logica de integracao com o Explorer ja existente em lib.rs
// (multi-idioma, HKCU, sem UAC) em vez de duplicar com HKLM/HKCR.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
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
    pub pct: u8,
    pub done: bool,
    pub error: Option<String>,
}

impl InstallProgress {
    fn emit(app: &AppHandle, step: &str, pct: u8, done: bool, error: Option<String>) {
        let _ = app.emit(
            "install-progress",
            InstallProgress {
                step: step.to_string(),
                pct,
                done,
                error,
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
            InstallProgress::emit(&app_clone, "Erro", 0, true, Some(msg));
        }
    });

    Ok(())
}

fn run_install(app: &AppHandle, opts: &InstallOptions) -> Result<(), Box<dyn std::error::Error>> {
    let install_path = PathBuf::from(&opts.install_path);

    if install_path.as_os_str().is_empty() {
        return Err("Caminho de instalacao vazio.".into());
    }

    InstallProgress::emit(app, "Validando caminho de instalacao...", 5, false, None);
    validate_install_path_inner(&install_path).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

    InstallProgress::emit(app, "Criando pasta de instalacao...", 10, false, None);
    fs::create_dir_all(&install_path)?;

    InstallProgress::emit(app, "Copiando arquivos...", 25, false, None);
    copy_app_files(app, &install_path)?;

    if opts.install_deps {
        InstallProgress::emit(app, "Preparando dependencias...", 45, false, None);
        // Dependencias (ALASS/FFmpeg/FFprobe) sao baixadas pelo app na primeira
        // execucao via backend em %LocalAppData%\Syncora\bin. Nenhuma acao aqui.
    }

    InstallProgress::emit(app, "Criando atalhos...", 65, false, None);
    create_shortcuts(&install_path)?;

    InstallProgress::emit(app, "Registrando no sistema...", 80, false, None);
    register_uninstaller(&install_path)?;
    mark_as_installed(app, &install_path)?;

    if opts.install_explorer {
        InstallProgress::emit(app, "Instalando menu do Explorer...", 90, false, None);
        if let Err(e) = super::install_explorer_integration_native() {
            log::warn!("Falha na integracao com Explorer: {e}");
        }
    }

    InstallProgress::emit(app, "Concluido!", 100, true, None);
    Ok(())
}

fn copy_app_files(app: &AppHandle, dest: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let exe_path = std::env::current_exe()?;
    let exe_dir = exe_path
        .parent()
        .ok_or("Nao foi possivel determinar o diretorio do executavel.")?;

    let exe_dest = dest.join("Syncora.exe");
    fs::copy(&exe_path, &exe_dest)
        .map_err(|e| format!("Falha ao copiar Syncora.exe: {e}"))?;

    let helper_src = exe_dir.join("syncora-open.exe");
    let helper_dest = dest.join("syncora-open.exe");
    if helper_src.is_file() {
        fs::copy(&helper_src, &helper_dest)
            .map_err(|e| format!("Falha ao copiar syncora-open.exe: {e}"))?;
    } else {
        log::warn!("syncora-open.exe nao encontrado em {}", helper_src.display());
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let backend_src = resource_dir.join("backend").join("syncora-backend.exe");
        if backend_src.is_file() {
            let backend_dest = dest.join("backend").join("syncora-backend.exe");
            if let Some(parent) = backend_dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&backend_src, &backend_dest)
                .map_err(|e| format!("Falha ao copiar backend: {e}"))?;
        }

        for icon_name in ["icon.ico", "32x32.png", "128x128.png", "128x128@2x.png"] {
            let icon_src = resource_dir.join("icons").join(icon_name);
            if icon_src.is_file() {
                let icon_dest = dest.join("icons").join(icon_name);
                if let Some(parent) = icon_dest.parent() {
                    fs::create_dir_all(parent)?;
                }
                let _ = fs::copy(&icon_src, &icon_dest);
            }
        }
    }

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

        if let Ok(hkcu) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(REG_HKCU_BASE)
            .and_then(|key| key.get_value::<String, _>(REG_INSTALL_PATH))
        {
            log::info!("Desinstalando de: {hkcu}");

            super::uninstall_explorer_integration_native();

            let _ = fs::remove_dir_all(&hkcu);

            if let Some(local) = dirs::data_local_dir() {
                let _ = fs::remove_file(local.join("app.syncora.desktop").join(".installed"));
            }

            let hkcu_root = RegKey::predef(HKEY_CURRENT_USER);
            let _ = hkcu_root.delete_subkey_all(REG_UNINSTALL_KEY);
            let _ = hkcu_root.delete_subkey_all(REG_HKCU_BASE);

            log::info!("Desinstalacao concluida.");
        } else {
            log::warn!("Syncora nao esta instalado em HKCU\\Software\\Syncora.");
        }
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
    format!(
        r#"
        Start-Sleep -Seconds 2
        Get-Process -Name 'syncora' -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 1
        $ErrorActionPreference = 'SilentlyContinue'
        Remove-Item -LiteralPath '{path}' -Recurse -Force
        Remove-Item -LiteralPath '{local}\.installed' -Force
        Remove-Item -LiteralPath 'HKCU:\Software\Syncora' -Recurse -Force
        Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Syncora' -Recurse -Force
        $desktop = [Environment]::GetFolderPath('Desktop')
        Remove-Item -LiteralPath "$desktop\Syncora.lnk" -Force
        $startMenu = [Environment]::GetFolderPath('ApplicationData') + '\Microsoft\Windows\Start Menu\Programs\Syncora'
        Remove-Item -LiteralPath $startMenu -Recurse -Force
        "#,
        path = path,
        local = local,
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
