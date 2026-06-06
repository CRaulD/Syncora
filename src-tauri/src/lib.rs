use std::env;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::Serialize;
use tauri::{Manager, RunEvent};

const BACKEND_ADDR: &str = "127.0.0.1:8765";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const VIDEO_EXTS: &[&str] = &["mkv", "mp4", "avi", "mov", "wmv", "m4v"];
const DEFAULT_LAUNCH_ACTION: &str = "queue";

#[derive(Default)]
struct BackendState {
    child: Mutex<Option<Child>>,
}

#[derive(Serialize)]
struct ExplorerIntegrationStatus {
    installed: bool,
    helper_path: String,
    wrapper_dir: String,
    send_to_dir: String,
    message: String,
}

fn backend_is_reachable() -> bool {
    let addr = match BACKEND_ADDR.parse::<SocketAddr>() {
        Ok(value) => value,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn wait_backend_ready(timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() <= timeout {
        if backend_is_reachable() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

fn looks_like_backend_dir(path: &Path) -> bool {
    path.join("server.py").is_file()
}

fn candidate_backend_dirs(app: &tauri::App) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(project_root) = env::var("SYNCORA_PROJECT_ROOT") {
        let root = PathBuf::from(project_root);
        candidates.push(root.clone());
        candidates.push(root.join("backend"));
    }

    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.clone());
        candidates.push(cwd.join("backend"));
        candidates.push(cwd.join("..").join("backend"));
        candidates.push(cwd.join("..").join("..").join("backend"));
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.to_path_buf());
            candidates.push(exe_dir.join("backend"));
            candidates.push(exe_dir.join("..").join("backend"));
            candidates.push(exe_dir.join("..").join("..").join("backend"));
            candidates.push(exe_dir.join("..").join("..").join("..").join("backend"));
            candidates.push(
                exe_dir
                    .join("..")
                    .join("..")
                    .join("..")
                    .join("..")
                    .join("backend"),
            );
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("backend"));
    }

    candidates
}

fn find_backend_dir(app: &tauri::App) -> Option<PathBuf> {
    candidate_backend_dirs(app)
        .into_iter()
        .find(|path| looks_like_backend_dir(path))
}

fn candidate_backend_exes(app: &tauri::App) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("backend").join("syncora-backend.exe"));
        candidates.push(resource_dir.join("syncora-backend.exe"));
    }

    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("backend").join("dist").join("syncora-backend.exe"));
        candidates.push(cwd.join("..").join("backend").join("dist").join("syncora-backend.exe"));
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("syncora-backend.exe"));
            candidates.push(exe_dir.join("..").join("syncora-backend.exe"));
            candidates.push(exe_dir.join("..").join("..").join("syncora-backend.exe"));
        }
    }

    candidates
}

fn find_backend_exe(app: &tauri::App) -> Option<PathBuf> {
    candidate_backend_exes(app)
        .into_iter()
        .find(|path| path.is_file())
}

fn looks_like_project_root(path: &Path) -> bool {
    path.join("scripts")
        .join("install-context-menu.ps1")
        .is_file()
        && path
            .join("scripts")
            .join("uninstall-context-menu.ps1")
            .is_file()
}

fn project_root_candidates(app_handle: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(project_root) = env::var("SYNCORA_PROJECT_ROOT") {
        candidates.push(PathBuf::from(project_root));
    }

    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.clone());
        candidates.push(cwd.join(".."));
        candidates.push(cwd.join("..").join(".."));
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.to_path_buf());
            candidates.push(exe_dir.join(".."));
            candidates.push(exe_dir.join("..").join(".."));
            candidates.push(exe_dir.join("..").join("..").join(".."));
        }
    }

    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        candidates.push(resource_dir);
    }

    candidates
}

fn find_project_root(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    project_root_candidates(app_handle)
        .into_iter()
        .find(|path| looks_like_project_root(path))
}

fn build_backend_command(python_exe: &str, backend_dir: &Path) -> Command {
    let mut cmd = Command::new(python_exe);
    cmd.arg("-m")
        .arg("uvicorn")
        .arg("server:app")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("8765")
        .current_dir(backend_dir)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

fn spawn_backend_exe(backend_exe: &Path) -> Result<Child, String> {
    let mut cmd = Command::new(backend_exe);
    if let Some(parent) = backend_exe.parent() {
        cmd.current_dir(parent);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map_err(|err| format!("Nao foi possivel iniciar backend empacotado: {err}"))
}

fn spawn_backend_python_process(backend_dir: &Path) -> Result<Child, String> {
    let mut last_error = String::new();

    for python_exe in ["py", "python"] {
        match build_backend_command(python_exe, backend_dir).spawn() {
            Ok(child) => return Ok(child),
            Err(err) => {
                last_error = format!("{python_exe}: {err}");
            }
        }
    }

    Err(format!("Nao foi possivel iniciar backend ({last_error})"))
}

fn start_backend_if_needed(app: &tauri::App) {
    if backend_is_reachable() {
        log::info!("Backend ja estava online em {}", BACKEND_ADDR);
        return;
    }

    let child = if let Some(backend_exe) = find_backend_exe(app) {
        match spawn_backend_exe(&backend_exe) {
            Ok(value) => {
                log::info!("Backend empacotado iniciado: {}", backend_exe.display());
                value
            }
            Err(err) => {
                log::warn!("{err}");
                return;
            }
        }
    } else {
        let Some(backend_dir) = find_backend_dir(app) else {
            log::warn!("Backend nao encontrado. Verifique sidecar ou pasta 'backend' com server.py.");
            return;
        };

        match spawn_backend_python_process(&backend_dir) {
            Ok(value) => {
                log::info!("Backend Python iniciado: {}", backend_dir.display());
                value
            }
            Err(err) => {
                log::warn!("{err}");
                return;
            }
        }
    };

    if let Ok(mut guard) = app.state::<BackendState>().child.lock() {
        *guard = Some(child);
    }

    if wait_backend_ready(Duration::from_secs(10)) {
        log::info!("Backend iniciado automaticamente em {}", BACKEND_ADDR);
        return;
    }

    if let Ok(mut guard) = app.state::<BackendState>().child.lock() {
        if let Some(child) = guard.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                log::warn!("Backend encerrou ao iniciar (status: {}).", status);
            } else {
                log::warn!("Backend nao respondeu a tempo em {}.", BACKEND_ADDR);
            }
        }
    }
}

fn stop_backend_if_spawned(app_handle: &tauri::AppHandle) {
    if let Ok(mut guard) = app_handle.state::<BackendState>().child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            log::info!("Backend iniciado pelo app foi encerrado.");
        }
    }
}

fn normalize_launch_file(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed.starts_with("--") {
        return None;
    }

    let path = PathBuf::from(trimmed);
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())?;

    if !VIDEO_EXTS.iter().any(|allowed| *allowed == ext) || !path.is_file() {
        return None;
    }

    match path.canonicalize() {
        Ok(value) => Some(clean_windows_verbatim_path(&value.to_string_lossy())),
        Err(_) => Some(clean_windows_verbatim_path(&path.to_string_lossy())),
    }
}

fn clean_windows_verbatim_path(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    raw.strip_prefix(r"\\?\").unwrap_or(raw).to_string()
}

fn append_launch_file(files: &mut Vec<String>, raw: &str) {
    if let Some(path) = normalize_launch_file(raw) {
        let key = path.to_ascii_lowercase();
        if !files
            .iter()
            .any(|current| current.to_ascii_lowercase() == key)
        {
            files.push(path);
        }
    }
}

fn append_json_launch_files(files: &mut Vec<String>, json_path: &str) {
    let Ok(payload) = fs::read_to_string(json_path.trim().trim_matches('"')) else {
        return;
    };
    let Ok(values) = serde_json::from_str::<Vec<String>>(&payload) else {
        return;
    };
    for value in values {
        append_launch_file(files, &value);
    }
}

fn normalize_launch_action(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "download" | "baixar" | "baixar-legenda" | "download-only" => "download".to_string(),
        "download-sync" | "baixar-sincronizar" | "sync" | "sincronizar" => {
            "download-sync".to_string()
        }
        _ => DEFAULT_LAUNCH_ACTION.to_string(),
    }
}

#[tauri::command]
fn get_launch_files() -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    let mut args = env::args().skip(1).peekable();

    while let Some(arg) = args.next() {
        if arg == "--syncora-files" || arg == "--syncora-files-json" {
            if let Some(json_path) = args.next() {
                append_json_launch_files(&mut files, &json_path);
            }
            continue;
        }

        append_launch_file(&mut files, &arg);
    }

    if let Ok(raw_files) = env::var("SYNCORA_FILES") {
        for value in raw_files.split('|') {
            append_launch_file(&mut files, value);
        }
    }

    if let Ok(json_path) = env::var("SYNCORA_FILES_JSON") {
        append_json_launch_files(&mut files, &json_path);
    }

    files
}

#[tauri::command]
fn get_launch_action() -> String {
    let mut args = env::args().skip(1).peekable();

    while let Some(arg) = args.next() {
        if arg == "--syncora-action" || arg == "--action" || arg == "--mode" {
            if let Some(value) = args.next() {
                return normalize_launch_action(&value);
            }
        }
        if let Some(value) = arg
            .strip_prefix("--syncora-action=")
            .or_else(|| arg.strip_prefix("--action="))
            .or_else(|| arg.strip_prefix("--mode="))
        {
            return normalize_launch_action(value);
        }
    }

    env::var("SYNCORA_ACTION")
        .map(|value| normalize_launch_action(&value))
        .unwrap_or_else(|_| DEFAULT_LAUNCH_ACTION.to_string())
}

fn env_dir(name: &str) -> PathBuf {
    env::var(name)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::new())
}

fn explorer_wrapper_dir() -> PathBuf {
    env_dir("LOCALAPPDATA")
        .join("Syncora")
        .join("ExplorerIntegration")
}

fn explorer_send_to_dir() -> PathBuf {
    env_dir("APPDATA")
        .join("Microsoft")
        .join("Windows")
        .join("SendTo")
}

fn explorer_integration_status() -> ExplorerIntegrationStatus {
    let wrapper_dir = explorer_wrapper_dir();
    let send_to_dir = explorer_send_to_dir();
    let wrappers = [
        "Syncora.OpenQueue.cmd",
        "Syncora.DownloadSubtitles.cmd",
        "Syncora.DownloadAndSync.cmd",
    ];
    let shortcuts = [
        "Syncora - abrir na fila.lnk",
        "Syncora - baixar legendas.lnk",
        "Syncora - baixar e sincronizar.lnk",
    ];

    let wrappers_ok = wrappers.iter().all(|name| wrapper_dir.join(name).is_file());
    let shortcuts_ok = shortcuts
        .iter()
        .all(|name| send_to_dir.join(name).is_file());
    let helper_path = env::var("SYNCORA_APP_EXE").unwrap_or_default();
    let installed = wrappers_ok && shortcuts_ok;
    let message = if installed {
        "Integração instalada.".to_string()
    } else if wrappers_ok || shortcuts_ok {
        "Integração parcial. Reinstale para reparar.".to_string()
    } else {
        "Integração não instalada.".to_string()
    };

    ExplorerIntegrationStatus {
        installed,
        helper_path,
        wrapper_dir: wrapper_dir.to_string_lossy().to_string(),
        send_to_dir: send_to_dir.to_string_lossy().to_string(),
        message,
    }
}

fn run_context_script(app_handle: &tauri::AppHandle, script_name: &str) -> Result<(), String> {
    let project_root = find_project_root(app_handle)
        .ok_or_else(|| "Não encontrei a pasta do projeto Syncora.".to_string())?;
    let script = project_root.join("scripts").join(script_name);
    if !script.is_file() {
        return Err(format!("Script não encontrado: {}", script.display()));
    }

    let mut command = Command::new("powershell");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .current_dir(&project_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|err| format!("Falha ao executar PowerShell: {err}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let details = if stderr.is_empty() { stdout } else { stderr };
    Err(if details.is_empty() {
        format!("Script falhou com status {}", output.status)
    } else {
        details
    })
}

#[tauri::command]
fn get_explorer_integration_status() -> ExplorerIntegrationStatus {
    explorer_integration_status()
}

#[tauri::command]
fn install_explorer_integration(
    app_handle: tauri::AppHandle,
) -> Result<ExplorerIntegrationStatus, String> {
    run_context_script(&app_handle, "install-context-menu.ps1")?;
    Ok(explorer_integration_status())
}

#[tauri::command]
fn uninstall_explorer_integration(
    app_handle: tauri::AppHandle,
) -> Result<ExplorerIntegrationStatus, String> {
    run_context_script(&app_handle, "uninstall-context-menu.ps1")?;
    Ok(explorer_integration_status())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.manage(BackendState::default());
            start_backend_if_needed(app);
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_launch_files,
            get_launch_action,
            get_explorer_integration_status,
            install_explorer_integration,
            uninstall_explorer_integration
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::Exit | RunEvent::ExitRequested { .. } => {
                stop_backend_if_spawned(app_handle);
            }
            _ => {}
        });
}
