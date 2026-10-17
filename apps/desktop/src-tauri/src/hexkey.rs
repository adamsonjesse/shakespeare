pub fn is_public_key(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn require_public_key(value: &str) -> Result<(), String> {
    if is_public_key(value) {
        Ok(())
    } else {
        Err("Public key must be 64 lowercase hex characters".to_string())
    }
}

pub fn decode_private_key(value: &str) -> Result<Vec<u8>, String> {
    if value.len() != 64 {
        return Err("Key material is not valid hex".to_string());
    }
    let mut out = Vec::with_capacity(32);
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let hi = hex_value(bytes[index])?;
        let lo = hex_value(bytes[index + 1])?;
        out.push((hi << 4) | lo);
        index += 2;
    }
    Ok(out)
}

pub fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn hex_value(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err("Key material is not valid hex".to_string()),
    }
}
