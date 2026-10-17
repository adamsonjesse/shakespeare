use crate::hexkey::{decode_private_key, encode_hex, require_public_key};

const SERVICE: &str = "app.shakespeare.desktop";

#[tauri::command]
pub fn keystore_save(public_key: String, private_key: String) -> Result<(), String> {
    require_public_key(&public_key)?;
    let secret = decode_private_key(&private_key)?;
    let entry = keyring::Entry::new(SERVICE, &public_key).map_err(|err| err.to_string())?;
    entry.set_secret(&secret).map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn keystore_load(public_key: String) -> Result<Option<String>, String> {
    require_public_key(&public_key)?;
    let entry = keyring::Entry::new(SERVICE, &public_key).map_err(|err| err.to_string())?;
    match entry.get_secret() {
        Ok(secret) => {
            if secret.len() != 32 {
                return Err("The stored identity is unusable".to_string());
            }
            Ok(Some(encode_hex(&secret)))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}
