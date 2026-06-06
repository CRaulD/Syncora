use std::env;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use tauri::{Manager, RunEvent};

mod setup_installer;

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

#[derive(Clone, Copy)]
struct ExplorerAction {
    id: &'static str,
    action: &'static str,
    wrapper: &'static str,
    send_to_suffix: &'static str,
}

const EXPLORER_ACTIONS: &[ExplorerAction] = &[
    ExplorerAction {
        id: "Syncora.OpenQueue",
        action: "queue",
        wrapper: "Syncora.OpenQueue.cmd",
        send_to_suffix: "abrir na fila",
    },
    ExplorerAction {
        id: "Syncora.DownloadSubtitles",
        action: "download",
        wrapper: "Syncora.DownloadSubtitles.cmd",
        send_to_suffix: "baixar legendas",
    },
    ExplorerAction {
        id: "Syncora.DownloadAndSync",
        action: "download-sync",
        wrapper: "Syncora.DownloadAndSync.cmd",
        send_to_suffix: "baixar e sincronizar",
    },
];

struct LanguageLabels {
    open_queue: &'static str,
    download: &'static str,
    download_sync: &'static str,
}

const LABELS_PT_BR: LanguageLabels = LanguageLabels {
    open_queue: "Abrir com Syncora",
    download: "Baixar legendas",
    download_sync: "Baixar legendas e sincronizar",
};

const LABELS_EN: LanguageLabels = LanguageLabels {
    open_queue: "Open with Syncora",
    download: "Download subtitles",
    download_sync: "Download subtitles and sync",
};

const LABELS_ES: LanguageLabels = LanguageLabels {
    open_queue: "Abrir con Syncora",
    download: "Descargar subtitulos",
    download_sync: "Descargar subtitulos y sincronizar",
};

fn labels_for(lang: &str) -> &'static LanguageLabels {
    match lang {
        "en" => &LABELS_EN,
        "es" => &LABELS_ES,
        _ => &LABELS_PT_BR,
    }
}

fn label_for_action(action: ExplorerAction, lang: &str) -> &'static str {
    let labels = labels_for(lang);
    match action.id {
        "Syncora.OpenQueue" => labels.open_queue,
        "Syncora.DownloadSubtitles" => labels.download,
        "Syncora.DownloadAndSync" => labels.download_sync,
        _ => "",
    }
}

fn send_to_basename(action: ExplorerAction, lang: &str) -> String {
    let prefix = match lang {
        "en" => "Syncora - ",
        "es" => "Syncora - ",
        _ => "Syncora - ",
    };
    let suffix = action.send_to_suffix;
    let suffix = match lang {
        "en" => match suffix {
            "abrir na fila" => "add to queue",
            "baixar legendas" => "download subtitles",
            "baixar e sincronizar" => "download and sync",
            other => other,
        },
        "es" => match suffix {
            "abrir na fila" => "agregar a la cola",
            "baixar legendas" => "descargar subtitulos",
            "baixar e sincronizar" => "descargar y sincronizar",
            other => other,
        },
        _ => suffix,
    };
    format!("{prefix}{suffix}")
}

fn current_app_exe() -> Result<PathBuf, String> {
    env::current_exe().map_err(|err| format!("Nao encontrei o executavel do Syncora: {err}"))
}

fn current_helper_exe(app_exe: &Path) -> Result<PathBuf, String> {
    let app_dir = app_exe
        .parent()
        .ok_or_else(|| "Nao encontrei a pasta do executavel do Syncora.".to_string())?;
    let helper = app_dir.join("syncora-open.exe");
    if helper.is_file() {
        return Ok(helper);
    }

    if let Ok(project_root) = env::var("SYNCORA_PROJECT_ROOT") {
        for profile in ["debug", "release"] {
            let candidate = PathBuf::from(&project_root)
                .join("src-tauri")
                .join("target")
                .join(profile)
                .join("syncora-open.exe");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err(format!(
        "syncora-open.exe nao encontrado ao lado do app: {}",
        helper.display()
    ))
}

fn quoted_path(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy())
}

fn explorer_wrapper_content(action: ExplorerAction, app_exe: &Path, helper_exe: &Path) -> String {
    format!(
        "@echo off\r\nset \"SYNCORA_ACTION={}\"\r\nset \"SYNCORA_APP_EXE={}\"\r\n{} --syncora-action {} %*\r\n",
        action.action,
        app_exe.to_string_lossy(),
        quoted_path(helper_exe),
        action.action
    )
}

fn reg_add(key: &str, name: Option<&str>, value: &str) -> Result<(), String> {
    let mut command = Command::new("reg");
    command.arg("add").arg(key);
    if let Some(name) = name {
        command.arg("/v").arg(name);
    } else {
        command.arg("/ve");
    }
    command.arg("/t").arg("REG_SZ").arg("/d").arg(value).arg("/f");

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|err| format!("Falha ao executar reg.exe: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn reg_delete(key: &str) {
    let mut command = Command::new("reg");
    command.arg("delete").arg(key).arg("/f");
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = command.output();
}

fn register_explorer_verb(
    ext: &str,
    action: ExplorerAction,
    label: &str,
    app_exe: &Path,
    wrapper_path: &Path,
) -> Result<(), String> {
    let base = format!(
        r"HKCU\Software\Classes\SystemFileAssociations\{}\shell\{}",
        ext, action.id
    );
    reg_add(&base, None, label)?;
    reg_add(&base, Some("MUIVerb"), label)?;
    reg_add(&base, Some("Icon"), &app_exe.to_string_lossy())?;
    reg_add(&base, Some("MultiSelectModel"), "Player")?;
    reg_add(&base, Some("Position"), "Top")?;
    reg_add(
        &format!(r"{}\command", base),
        None,
        &format!("\"{}\" \"%1\"", wrapper_path.to_string_lossy()),
    )?;
    Ok(())
}

fn install_explorer_integration_native() -> Result<(), String> {
    let app_exe = current_app_exe()?;
    let helper_exe = current_helper_exe(&app_exe)?;
    let wrapper_dir = explorer_wrapper_dir();
    let send_to_dir = explorer_send_to_dir();

    fs::create_dir_all(&wrapper_dir)
        .map_err(|err| format!("Nao foi possivel criar a pasta da integracao: {err}"))?;
    if !send_to_dir.as_os_str().is_empty() {
        let _ = fs::create_dir_all(&send_to_dir);
    }

    let initial_lang = env::var("SYNCORA_APP_LANG").unwrap_or_else(|_| "pt-BR".to_string());

    for action in EXPLORER_ACTIONS {
        let wrapper_path = wrapper_dir.join(action.wrapper);
        let content = explorer_wrapper_content(*action, &app_exe, &helper_exe);
        fs::write(&wrapper_path, &content)
            .map_err(|err| format!("Nao foi possivel criar wrapper do Explorer: {err}"))?;

        if !send_to_dir.as_os_str().is_empty() {
            let basename = send_to_basename(*action, &initial_lang);
            let _ = fs::write(send_to_dir.join(format!("{basename}.cmd")), &content);
        }

        let label = label_for_action(*action, &initial_lang);
        for ext in VIDEO_EXTS {
            register_explorer_verb(&format!(".{}", ext), *action, label, &app_exe, &wrapper_path)?;
        }
    }

    reg_add(
        r"HKCU\Software\Syncora\ExplorerIntegration",
        Some("HelperPath"),
        &helper_exe.to_string_lossy(),
    )?;
    reg_add(
        r"HKCU\Software\Syncora\ExplorerIntegration",
        Some("IconPath"),
        &app_exe.to_string_lossy(),
    )?;
    reg_add(
        r"HKCU\Software\Syncora\ExplorerIntegration",
        Some("WrapperDir"),
        &wrapper_dir.to_string_lossy(),
    )?;
    reg_add(
        r"HKCU\Software\Syncora\ExplorerIntegration",
        Some("Language"),
        &initial_lang,
    )?;

    Ok(())
}

fn uninstall_explorer_integration_native() {
    for ext in VIDEO_EXTS {
        for action in EXPLORER_ACTIONS {
            reg_delete(&format!(
                r"HKCU\Software\Classes\SystemFileAssociations\.{}\shell\{}",
                ext, action.id
            ));
        }
    }

    let wrapper_dir = explorer_wrapper_dir();
    for action in EXPLORER_ACTIONS {
        let _ = fs::remove_file(wrapper_dir.join(action.wrapper));
    }
    let _ = fs::remove_dir(&wrapper_dir);

    let send_to_dir = explorer_send_to_dir();
    if !send_to_dir.as_os_str().is_empty() {
        for action in EXPLORER_ACTIONS {
            for lang in ["pt-BR", "en", "es"] {
                let basename = send_to_basename(*action, lang);
                let _ = fs::remove_file(send_to_dir.join(format!("{basename}.cmd")));
                let _ = fs::remove_file(send_to_dir.join(format!("{basename}.lnk")));
            }
        }
    }

    reg_delete(r"HKCU\Software\Syncora\ExplorerIntegration");
}

fn update_explorer_integration_labels(lang: &str) -> Result<(), String> {
    let app_exe = current_app_exe()?;
    let helper_exe = current_helper_exe(&app_exe)?;
    let wrapper_dir = explorer_wrapper_dir();
    let send_to_dir = explorer_send_to_dir();

    if !wrapper_dir.is_dir() {
        return Err("Integracao nao instalada.".to_string());
    }

    for action in EXPLORER_ACTIONS {
        let wrapper_path = wrapper_dir.join(action.wrapper);
        if !wrapper_path.is_file() {
            return Err(format!("Wrapper ausente: {}", wrapper_path.display()));
        }

        let label = label_for_action(*action, lang);

        for ext in VIDEO_EXTS {
            register_explorer_verb(&format!(".{}", ext), *action, label, &app_exe, &wrapper_path)?;
        }
    }

    if !send_to_dir.as_os_str().is_empty() {
        let _ = fs::create_dir_all(&send_to_dir);
        let content_template = |action: ExplorerAction| -> String {
            format!(
                "@echo off\r\nset \"SYNCORA_ACTION={}\"\r\nset \"SYNCORA_APP_EXE={}\"\r\n{} --syncora-action {} %*\r\n",
                action.action,
                app_exe.to_string_lossy(),
                quoted_path(&helper_exe),
                action.action
            )
        };

        for action in EXPLORER_ACTIONS {
            for prev_lang in ["pt-BR", "en", "es"] {
                let prev_name = send_to_basename(*action, prev_lang);
                let _ = fs::remove_file(send_to_dir.join(format!("{prev_name}.cmd")));
                let _ = fs::remove_file(send_to_dir.join(format!("{prev_name}.lnk")));
            }
            let new_name = send_to_basename(*action, lang);
            let content = content_template(*action);
            let _ = fs::write(send_to_dir.join(format!("{new_name}.cmd")), &content);
        }
    }

    reg_add(
        r"HKCU\Software\Syncora\ExplorerIntegration",
        Some("Language"),
        lang,
    )?;

    Ok(())
}

fn explorer_integration_status() -> ExplorerIntegrationStatus {
    let wrapper_dir = explorer_wrapper_dir();
    let send_to_dir = explorer_send_to_dir();
    let wrappers_ok = EXPLORER_ACTIONS
        .iter()
        .all(|action| wrapper_dir.join(action.wrapper).is_file());
    let shortcuts_ok = if send_to_dir.as_os_str().is_empty() {
        false
    } else {
        EXPLORER_ACTIONS.iter().all(|action| {
            ["pt-BR", "en", "es"].iter().any(|lang| {
                let basename = send_to_basename(*action, lang);
                send_to_dir.join(format!("{basename}.cmd")).is_file()
                    || send_to_dir.join(format!("{basename}.lnk")).is_file()
            })
        })
    };
    let helper_path = current_app_exe()
        .ok()
        .and_then(|app_exe| current_helper_exe(&app_exe).ok())
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let installed = wrappers_ok && shortcuts_ok;
    let message = if installed {
        "Integracao instalada.".to_string()
    } else if wrappers_ok || shortcuts_ok {
        "Integracao parcial. Reinstale para reparar.".to_string()
    } else {
        "Integracao nao instalada.".to_string()
    };

    ExplorerIntegrationStatus {
        installed,
        helper_path,
        wrapper_dir: wrapper_dir.to_string_lossy().to_string(),
        send_to_dir: send_to_dir.to_string_lossy().to_string(),
        message,
    }
}

#[tauri::command]
fn get_explorer_integration_status() -> ExplorerIntegrationStatus {
    explorer_integration_status()
}

#[tauri::command]
fn install_explorer_integration(
    app_handle: tauri::AppHandle,
) -> Result<ExplorerIntegrationStatus, String> {
    let _ = app_handle;
    install_explorer_integration_native()?;
    Ok(explorer_integration_status())
}

#[tauri::command]
fn uninstall_explorer_integration(
    app_handle: tauri::AppHandle,
) -> Result<ExplorerIntegrationStatus, String> {
    let _ = app_handle;
    uninstall_explorer_integration_native();
    Ok(explorer_integration_status())
}

#[tauri::command]
fn update_explorer_labels(
    app_handle: tauri::AppHandle,
    lang: String,
) -> Result<ExplorerIntegrationStatus, String> {
    let _ = app_handle;
    let status = explorer_integration_status();
    if !status.installed {
        return Err(status.message);
    }
    update_explorer_integration_labels(&lang)?;
    Ok(explorer_integration_status())
}

const UPDATE_CHECK_CACHE_HOURS: i64 = 24;
const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/CRaulD/Syncora/releases/latest";
const UPDATE_CACHE_FILE: &str = "update-check.json";

#[derive(Serialize, Deserialize, Clone)]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    has_update: bool,
    release_url: String,
    release_notes: String,
    checked_at: i64,
    from_cache: bool,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn update_cache_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(UPDATE_CACHE_FILE))
}

fn read_cached_update(app: &tauri::AppHandle) -> Option<UpdateInfo> {
    let path = update_cache_path(app)?;
    let content = fs::read_to_string(&path).ok()?;
    let cached: UpdateInfo = serde_json::from_str(&content).ok()?;
    let age_hours = (now_unix() - cached.checked_at) / 3600;
    if age_hours < UPDATE_CHECK_CACHE_HOURS {
        Some(UpdateInfo {
            from_cache: true,
            ..cached
        })
    } else {
        None
    }
}

fn write_cached_update(app: &tauri::AppHandle, info: &UpdateInfo) {
    if let Some(path) = update_cache_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(info) {
            let _ = fs::write(&path, json);
        }
    }
}

fn parse_release_tag(tag: &str) -> Option<semver::Version> {
    let trimmed = tag.trim().trim_start_matches('v').trim_start_matches('V');
    semver::Version::parse(trimmed).ok()
}

#[tauri::command]
async fn check_for_update(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<UpdateInfo, String> {
    let current_str = env!("CARGO_PKG_VERSION").to_string();

    if !force.unwrap_or(false) {
        if let Some(cached) = read_cached_update(&app) {
            log::info!(
                "Update check: cache hit ({}h old, has_update={})",
                (now_unix() - cached.checked_at) / 3600,
                cached.has_update
            );
            return Ok(cached);
        }
    }

    log::info!("Update check: fetching {GITHUB_RELEASES_URL}");

    let client = reqwest::Client::builder()
        .user_agent(concat!("Syncora/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Falha ao criar cliente HTTP: {e}"))?;

    let response = client
        .get(GITHUB_RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Falha na requisição: {e}"))?;

    let status = response.status();
    if status.as_u16() == 404 {
        return Err("Nenhuma release publicada no GitHub ainda.".into());
    }
    if status.as_u16() == 403 {
        return Err("Limite de requisições do GitHub excedido. Tente novamente em 1h.".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub retornou status {}", status));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Falha ao parsear resposta: {e}"))?;

    let latest_version = parse_release_tag(&release.tag_name)
        .map(|v| v.to_string())
        .unwrap_or_else(|| release.tag_name.trim_start_matches('v').to_string());

    let has_update = match (
        parse_release_tag(&release.tag_name),
        semver::Version::parse(&current_str),
    ) {
        (Some(latest), Ok(current)) => latest > current,
        _ => false,
    };

    let info = UpdateInfo {
        current_version: current_str,
        latest_version,
        has_update,
        release_url: release.html_url,
        release_notes: release.body.unwrap_or_default(),
        checked_at: now_unix(),
        from_cache: false,
    };

    write_cached_update(&app, &info);
    log::info!(
        "Update check: current={} latest={} has_update={}",
        info.current_version,
        info.latest_version,
        info.has_update
    );

    Ok(info)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if setup_installer::handle_uninstall_cli() {
        return;
    }

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

            let handle = app.handle().clone();
            if setup_installer::is_installed(&handle) {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Syncora")
                .inner_size(800.0, 800.0)
                .min_inner_size(800.0, 800.0)
                .max_inner_size(800.0, 800.0)
                .resizable(false)
                .maximizable(false)
                .decorations(true)
                .build()?;
                start_backend_if_needed(app);
            } else {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "setup",
                    tauri::WebviewUrl::App("setup.html".into()),
                )
                .title("Instalador do Syncora")
                .inner_size(760.0, 520.0)
                .resizable(false)
                .maximizable(false)
                .decorations(true)
                .center()
                .build()?;
            }

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_launch_files,
            get_launch_action,
            get_explorer_integration_status,
            install_explorer_integration,
            uninstall_explorer_integration,
            update_explorer_labels,
            setup_installer::start_install,
            setup_installer::launch_main_app,
            setup_installer::get_default_install_path,
            setup_installer::validate_install_path,
            check_for_update
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
