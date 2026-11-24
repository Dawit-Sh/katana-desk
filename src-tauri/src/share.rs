//! Share as an image: the quote card is drawn in the page; here it is saved where you chose (Pictures\Katana
//! by default). Test runs (KATANA_DATA_DIR) save under their own folder instead of the real Pictures.

use crate::{err, Res};
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

/// Pictures\Katana, made if it isn't there yet.
#[tauri::command]
pub fn share_pictures_dir(app: AppHandle) -> Res<String> {
    let base = match std::env::var("KATANA_DATA_DIR") {
        Ok(d) => PathBuf::from(d).join("Pictures"),
        Err(_) => app.path().picture_dir().map_err(err)?,
    };
    let dir = base.join("Katana");
    std::fs::create_dir_all(&dir).map_err(|e| format!("The folder couldn't be made: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// `%41` and the like back to bytes (the path comes in a header, which only carries ASCII).
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Where the card goes: the chosen path, with `.png` added when the name has none.
fn png_path(p: &str) -> PathBuf {
    let path = PathBuf::from(p);
    let png = path.extension().map(|e| e.eq_ignore_ascii_case("png")).unwrap_or(false);
    if png {
        path
    } else {
        PathBuf::from(format!("{p}.png"))
    }
}

/// Saves the card. The request's body is the PNG; the header `path` (percent-encoded) says where.
#[tauri::command]
pub fn share_save_image(request: Request<'_>) -> Res<String> {
    let raw = request.headers().get("path").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let path = percent_decode(raw).filter(|p| !p.trim().is_empty()).ok_or("No place to save to")?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("No image".into()) };
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("That isn't a PNG image.".into());
    }
    let out = png_path(&path);
    std::fs::write(&out, bytes).map_err(|e| format!("The image couldn't be saved: {e}"))?;
    Ok(out.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_percent_encoded_path() {
        assert_eq!(percent_decode("C%3A%5CPictures%5CKatana%5C%E5%88%80%20a.png").unwrap(), "C:\\Pictures\\Katana\\刀 a.png");
        assert_eq!(percent_decode("plain").unwrap(), "plain");
        assert!(percent_decode("bad%2").is_none());
        assert!(percent_decode("bad%zz").is_none());
    }

    #[test]
    fn a_name_without_png_gets_it() {
        assert_eq!(png_path("C:\\x\\Quote"), PathBuf::from("C:\\x\\Quote.png"));
        assert_eq!(png_path("C:\\x\\Quote.PNG"), PathBuf::from("C:\\x\\Quote.PNG"));
        assert_eq!(png_path("C:\\x\\Mr. Bingley"), PathBuf::from("C:\\x\\Mr. Bingley.png"));
    }
}
