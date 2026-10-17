mod db;
mod files;
mod hexkey;
mod keystore;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(db::AppDb::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::db_execute,
            db::db_select,
            db::profile_list,
            db::profile_open,
            keystore::keystore_load,
            keystore::keystore_save,
            files::read_share_folder,
            files::remove_profile_blob,
            files::read_profile_blob,
            files::remove_download,
            files::write_download,
            files::write_profile_blob,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
