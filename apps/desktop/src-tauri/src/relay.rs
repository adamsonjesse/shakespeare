use std::io::{Read, Write};
use std::net::{TcpStream, SocketAddr};
use std::time::Duration;

const MAX_FRAME: usize = 1_048_576;

/// One length-prefixed JSON exchange with a hub or peer on this machine.
#[tauri::command]
pub fn relay_exchange(host: String, port: u16, request: String) -> Result<String, String> {
    if host != "127.0.0.1" || request.len() > MAX_FRAME {
        return Err("The request is not allowed.".to_string());
    }
    let address: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|_| "The hub is not reachable.".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))
        .map_err(|_| "The hub is not reachable.".to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "The hub is not reachable.".to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "The hub is not reachable.".to_string())?;
    let body = request.as_bytes();
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(body);
    stream
        .write_all(&frame)
        .map_err(|_| "The hub is not reachable.".to_string())?;
    let mut length_buf = [0_u8; 4];
    stream
        .read_exact(&mut length_buf)
        .map_err(|_| "The hub is not reachable.".to_string())?;
    let length = u32::from_be_bytes(length_buf) as usize;
    if length > MAX_FRAME {
        return Err("The request is not allowed.".to_string());
    }
    let mut response = vec![0_u8; length];
    stream
        .read_exact(&mut response)
        .map_err(|_| "The hub is not reachable.".to_string())?;
    String::from_utf8(response).map_err(|_| "The request is not allowed.".to_string())
}
