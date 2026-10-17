use crate::hexkey::{is_public_key, require_public_key};
use rusqlite::{types::ValueRef, Connection};
use serde_json::{Map, Number, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The open profile database. Empty until a profile is selected.
/// One connection so BEGIN and COMMIT share a session.
pub struct AppDb(Mutex<Option<Connection>>);

impl AppDb {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

#[tauri::command]
pub fn profile_list(app: AppHandle) -> Result<Vec<String>, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("profiles");
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.to_string()),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        if !entry.file_type().map_err(|err| err.to_string())?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if is_public_key(name) {
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
pub fn profile_open(app: AppHandle, db: tauri::State<'_, AppDb>, public_key: String) -> Result<(), String> {
    require_public_key(&public_key)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("profiles")
        .join(&public_key);
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let connection = Connection::open(dir.join("club.sqlite")).map_err(|err| err.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|err| err.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|err| err.to_string())?;
    let mut guard = db.0.lock().map_err(|_| "database lock poisoned".to_string())?;
    *guard = Some(connection);
    Ok(())
}

fn to_sql(value: &Value) -> Result<rusqlite::types::Value, String> {
    match value {
        Value::Null => Ok(rusqlite::types::Value::Null),
        Value::String(text) => Ok(rusqlite::types::Value::Text(text.clone())),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Ok(rusqlite::types::Value::Integer(integer))
            } else if let Some(real) = number.as_f64() {
                if !real.is_finite() {
                    return Err("SQL parameters must be finite numbers".to_string());
                }
                Ok(rusqlite::types::Value::Real(real))
            } else {
                Err("unsupported SQL number".to_string())
            }
        }
        Value::Bool(_) | Value::Array(_) | Value::Object(_) => {
            Err("SQL parameters must be null, string, or number".to_string())
        }
    }
}

fn from_sql(value: ValueRef<'_>) -> Result<Value, String> {
    match value {
        ValueRef::Null => Ok(Value::Null),
        ValueRef::Integer(integer) => Ok(Value::Number(integer.into())),
        ValueRef::Real(real) => Number::from_f64(real)
            .map(Value::Number)
            .ok_or_else(|| "non-finite REAL column".to_string()),
        ValueRef::Text(bytes) => String::from_utf8(bytes.to_vec())
            .map(Value::String)
            .map_err(|_| "TEXT column is not UTF-8".to_string()),
        // Blob bytes can be key material or file contents. Keep them out of the webview.
        ValueRef::Blob(_) => Err("BLOB columns are not returned".to_string()),
    }
}

fn bind(params: &[Value]) -> Result<Vec<rusqlite::types::Value>, String> {
    params.iter().map(to_sql).collect()
}

fn connection(db: &AppDb) -> Result<std::sync::MutexGuard<'_, Option<Connection>>, String> {
    db.0.lock().map_err(|_| "database lock poisoned".to_string())
}

#[tauri::command]
pub fn db_execute(db: tauri::State<'_, AppDb>, sql: String, params: Vec<Value>) -> Result<(), String> {
    let values = bind(&params)?;
    let guard = connection(&db)?;
    let Some(open) = guard.as_ref() else {
        return Err("No profile is open".to_string());
    };
    open.execute(&sql, rusqlite::params_from_iter(values.iter()))
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn db_select(
    db: tauri::State<'_, AppDb>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    let values = bind(&params)?;
    let guard = connection(&db)?;
    let Some(open) = guard.as_ref() else {
        return Err("No profile is open".to_string());
    };
    let mut statement = open.prepare(&sql).map_err(|err| err.to_string())?;
    let names: Vec<String> = statement.column_names().into_iter().map(str::to_string).collect();
    let mut rows = statement
        .query(rusqlite::params_from_iter(values.iter()))
        .map_err(|err| err.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let mut record = Map::new();
        for (index, name) in names.iter().enumerate() {
            record.insert(
                name.clone(),
                from_sql(row.get_ref(index).map_err(|err| err.to_string())?)?,
            );
        }
        out.push(record);
    }
    Ok(out)
}
