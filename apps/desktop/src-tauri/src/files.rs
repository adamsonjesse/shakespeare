use crate::hexkey::{is_public_key, require_public_key};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_FILES: usize = 20;
const MAX_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
pub struct SharedFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[tauri::command]
pub fn read_share_folder(path: String) -> Result<Vec<SharedFile>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("The folder is not available.".to_string());
    }
    let mut files = Vec::new();
    collect(&root, &root, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

#[tauri::command]
pub fn write_profile_blob(app: AppHandle, public_key: String, hash: String, bytes: Vec<u8>) -> Result<(), String> {
    require_hash(&hash)?;
    if bytes.len() > MAX_BYTES {
        return Err("The file is too large.".to_string());
    }
    let path = blob_path(&app, &public_key, &hash)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(path, bytes).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn read_profile_blob(app: AppHandle, public_key: String, hash: String) -> Result<Option<Vec<u8>>, String> {
    require_hash(&hash)?;
    let path = blob_path(&app, &public_key, &hash)?;
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn remove_profile_blob(app: AppHandle, public_key: String, hash: String) -> Result<(), String> {
    require_hash(&hash)?;
    let path = blob_path(&app, &public_key, &hash)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn write_download(app: AppHandle, public_key: String, relative_path: String, bytes: Vec<u8>) -> Result<(), String> {
    let path = download_path(&app, &public_key, &relative_path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    std::fs::write(path, bytes).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn remove_download(app: AppHandle, public_key: String, relative_path: String) -> Result<(), String> {
    let path = download_path(&app, &public_key, &relative_path)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

fn collect(root: &Path, dir: &Path, files: &mut Vec<SharedFile>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect(root, &path, files)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if files.len() >= MAX_FILES {
            return Err("The folder has too many files.".to_string());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "That path is not allowed.".to_string())?;
        let mut parts = Vec::new();
        for component in relative.components() {
            match component {
                Component::Normal(part) => {
                    let Some(text) = part.to_str() else {
                        return Err("That path is not allowed.".to_string());
                    };
                    parts.push(text.to_string());
                }
                _ => return Err("That path is not allowed.".to_string()),
            }
        }
        let bytes = std::fs::read(&path).map_err(|err| err.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Err("The file is too large.".to_string());
        }
        files.push(SharedFile {
            path: parts.join("/"),
            bytes,
        });
    }
    Ok(())
}

fn blob_path(app: &AppHandle, public_key: &str, hash: &str) -> Result<PathBuf, String> {
    require_public_key(public_key)?;
    Ok(profile_dir(app, public_key)?.join("blobs").join(hash))
}

fn download_path(app: &AppHandle, public_key: &str, relative_path: &str) -> Result<PathBuf, String> {
    require_public_key(public_key)?;
    if relative_path.is_empty() || relative_path.contains('\\') || relative_path.starts_with('/') {
        return Err("That path is not allowed.".to_string());
    }
    let mut path = profile_dir(app, public_key)?.join("downloads");
    for segment in relative_path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err("That path is not allowed.".to_string());
        }
        path.push(segment);
    }
    Ok(path)
}

fn profile_dir(app: &AppHandle, public_key: &str) -> Result<PathBuf, String> {
    if !is_public_key(public_key) {
        return Err("Public key must be 64 lowercase hex characters".to_string());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("profiles")
        .join(public_key))
}

fn require_hash(hash: &str) -> Result<(), String> {
    if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        Ok(())
    } else {
        Err("The file hash did not match.".to_string())
    }
}
