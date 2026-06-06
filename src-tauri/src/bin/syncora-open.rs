#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const VIDEO_EXTS: &[&str] = &["mkv", "mp4", "avi", "mov", "wmv", "m4v"];
const APP_EXE_NAMES: &[&str] = &["Syncora.exe", "app.exe"];
const DEFAULT_ACTION: &str = "queue";
const QUEUE_SETTLE_MS: u64 = 700;
const LOCK_SETTLE_MS: u64 = 200;
const STALE_LOCK_MS: u128 = 10_000;

#[derive(Debug)]
struct LaunchRequest {
    action: String,
    files: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct QueueEntry {
    action: String,
    files: Vec<String>,
}

fn normalize_action(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "download" | "baixar" | "baixar-legenda" | "download-only" => "download".to_string(),
        "download-sync" | "baixar-sincronizar" | "sync" | "sincronizar" => {
            "download-sync".to_string()
        }
        _ => DEFAULT_ACTION.to_string(),
    }
}

fn is_video_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };

    VIDEO_EXTS
        .iter()
        .any(|allowed| ext.eq_ignore_ascii_case(allowed))
}

fn normalize_file(arg: OsString) -> Option<String> {
    let path = PathBuf::from(arg);
    if !is_video_file(&path) {
        return None;
    }

    let resolved = path.canonicalize().unwrap_or(path);
    Some(clean_windows_verbatim_path(&resolved.to_string_lossy()))
}

fn clean_windows_verbatim_path(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    raw.strip_prefix(r"\\?\").unwrap_or(raw).to_string()
}

fn collect_launch_request() -> LaunchRequest {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    let mut action = env::var("SYNCORA_ACTION")
        .map(|value| normalize_action(&value))
        .unwrap_or_else(|_| DEFAULT_ACTION.to_string());
    let mut args = env::args_os().skip(1).peekable();

    while let Some(arg) = args.next() {
        let arg_text = arg.to_string_lossy().to_string();
        if arg_text == "--syncora-action" || arg_text == "--action" || arg_text == "--mode" {
            if let Some(next) = args.next() {
                action = normalize_action(&next.to_string_lossy());
            }
            continue;
        }
        if let Some(value) = arg_text
            .strip_prefix("--syncora-action=")
            .or_else(|| arg_text.strip_prefix("--action="))
            .or_else(|| arg_text.strip_prefix("--mode="))
        {
            action = normalize_action(value);
            continue;
        }

        let Some(path) = normalize_file(arg) else {
            continue;
        };
        let key = path.to_ascii_lowercase();
        if seen.insert(key) {
            files.push(path);
        }
    }

    LaunchRequest { action, files }
}

fn write_launch_files_json(files: &[String]) -> Option<PathBuf> {
    let started = now_millis();
    let path = env::temp_dir().join(format!("syncora-launch-files-{started}.json"));
    let payload = serde_json::to_string(files).ok()?;
    fs::write(&path, payload).ok()?;
    Some(path)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

fn queue_dir(action: &str) -> PathBuf {
    env::temp_dir().join("syncora-explorer-launch").join(action)
}

fn write_queue_entry(request: &LaunchRequest) -> Option<PathBuf> {
    let dir = queue_dir(&request.action);
    fs::create_dir_all(&dir).ok()?;

    let path = dir.join(format!(
        "request-{}-{}.json",
        now_millis(),
        std::process::id()
    ));
    let entry = QueueEntry {
        action: request.action.clone(),
        files: request.files.clone(),
    };
    let payload = serde_json::to_string(&entry).ok()?;
    fs::write(&path, payload).ok()?;
    Some(path)
}

fn remove_stale_lock(lock_path: &Path) {
    let Ok(metadata) = fs::metadata(lock_path) else {
        return;
    };
    let Ok(modified) = metadata.modified() else {
        return;
    };
    let Ok(age) = SystemTime::now().duration_since(modified) else {
        return;
    };
    if age.as_millis() > STALE_LOCK_MS {
        let _ = fs::remove_file(lock_path);
    }
}

fn acquire_queue_lock(action: &str) -> Option<(fs::File, PathBuf)> {
    let dir = queue_dir(action);
    fs::create_dir_all(&dir).ok()?;
    let lock_path = dir.join("launch.lock");
    remove_stale_lock(&lock_path);

    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
    {
        Ok(lock) => Some((lock, lock_path)),
        Err(err) if err.kind() == ErrorKind::AlreadyExists => None,
        Err(_) => None,
    }
}

fn collect_queued_request(action: &str) -> LaunchRequest {
    let dir = queue_dir(action);
    let mut seen = HashSet::new();
    let mut files = Vec::new();

    let Ok(entries) = fs::read_dir(&dir) else {
        return LaunchRequest {
            action: action.to_string(),
            files,
        };
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }

        let Ok(payload) = fs::read_to_string(&path) else {
            let _ = fs::remove_file(&path);
            continue;
        };
        let Ok(queue_entry) = serde_json::from_str::<QueueEntry>(&payload) else {
            let _ = fs::remove_file(&path);
            continue;
        };
        if queue_entry.action != action {
            continue;
        }

        for file in queue_entry.files {
            let key = file.to_ascii_lowercase();
            if seen.insert(key) {
                files.push(file);
            }
        }

        let _ = fs::remove_file(&path);
    }

    LaunchRequest {
        action: action.to_string(),
        files,
    }
}

fn coalesce_launch_request(request: LaunchRequest) -> Option<LaunchRequest> {
    if write_queue_entry(&request).is_none() {
        return Some(request);
    }

    thread::sleep(Duration::from_millis(QUEUE_SETTLE_MS));

    let Some((_lock, lock_path)) = acquire_queue_lock(&request.action) else {
        return None;
    };

    thread::sleep(Duration::from_millis(LOCK_SETTLE_MS));
    let merged = collect_queued_request(&request.action);
    let _ = fs::remove_file(lock_path);

    if merged.files.is_empty() {
        None
    } else {
        Some(merged)
    }
}

fn existing_candidate(path: PathBuf) -> Option<PathBuf> {
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

fn app_candidates_from_dir(dir: &Path) -> Vec<PathBuf> {
    APP_EXE_NAMES.iter().map(|name| dir.join(name)).collect()
}

fn find_syncora_exe() -> Option<PathBuf> {
    if let Ok(raw) = env::var("SYNCORA_APP_EXE") {
        if let Some(path) = existing_candidate(PathBuf::from(raw)) {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();

    if let Ok(helper_exe) = env::current_exe() {
        if let Some(dir) = helper_exe.parent() {
            candidates.extend(app_candidates_from_dir(dir));
            if let Some(parent) = dir.parent() {
                candidates.extend(app_candidates_from_dir(parent));
            }
        }
    }

    if let Ok(cwd) = env::current_dir() {
        candidates.extend(app_candidates_from_dir(&cwd));
    }

    candidates.into_iter().find(|path| path.is_file())
}

fn detect_project_root() -> Option<PathBuf> {
    let helper_exe = env::current_exe().ok()?;
    let mut current = helper_exe.parent()?;

    loop {
        if current.join("backend").join("server.py").is_file() {
            return Some(current.to_path_buf());
        }

        current = current.parent()?;
    }
}

fn launch_syncora(app_exe: &Path, request: &LaunchRequest) -> Result<(), String> {
    let mut command = Command::new(app_exe);
    command.arg("--syncora-action").arg(&request.action);
    command.env("SYNCORA_ACTION", &request.action);

    if let Some(json_path) = write_launch_files_json(&request.files) {
        command.arg("--syncora-files-json").arg(&json_path);
        command.env("SYNCORA_FILES_JSON", json_path);
    } else {
        command.args(&request.files);
        command.env("SYNCORA_FILES", request.files.join("|"));
    }

    if let Some(project_root) = detect_project_root() {
        command.current_dir(&project_root);
        command.env("SYNCORA_PROJECT_ROOT", project_root);
    }

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Falha ao iniciar Syncora: {err}"))
}

fn main() {
    let request = collect_launch_request();
    if request.files.is_empty() {
        eprintln!("Nenhum video valido recebido.");
        return;
    }

    let Some(request) = coalesce_launch_request(request) else {
        return;
    };

    let Some(app_exe) = find_syncora_exe() else {
        eprintln!("Syncora.exe nao encontrado. Use SYNCORA_APP_EXE para indicar o executavel.");
        return;
    };

    if let Err(err) = launch_syncora(&app_exe, &request) {
        eprintln!("{err}");
    }
}
