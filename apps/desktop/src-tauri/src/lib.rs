mod db;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let connection = db::open(app.handle()).map_err(std::io::Error::other)?;
            app.manage(db::AppDb::new(connection));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![db::db_execute, db::db_select])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
