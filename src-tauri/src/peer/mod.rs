//! Sync on this Wi-Fi: Katana on a phone or tablet syncs its Local books with this PC without a
//! Grimmory server. While Settings › Sync on this Wi-Fi is on, this PC answers on port 47615 (every
//! network it's on) the same `/api/v1/...` requests Grimmory answers, for its own books, so Katana's
//! Grimmory code and rules work unchanged; it shows itself on the network as `_katana-desk._tcp`
//! (mDNS). Pairing and the matching of books are its own (`/katana-sync/v1/...`).
//! The plan: `projects/katana/2026-11-21-local-sync-plan.md` in Universe.

pub mod api;
pub mod pair;
pub mod place;

use crate::db;
use crate::grimmory::conn_of;
use crate::grimmory::place::ServerPlace;
use pair::{Device, Pairing};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

pub const PORT: u16 = 47615;
pub const SERVICE: &str = "_katana-desk._tcp.local.";
pub const PROTOCOL: i64 = 1;

struct Running {
    server: Arc<tiny_http::Server>,
    mdns: Option<(mdns_sd::ServiceDaemon, String)>,
}

#[derive(Default)]
pub struct Peer {
    pairing: Mutex<Pairing>,
    running: Mutex<Option<Running>>,
    error: Mutex<Option<String>>,
}

fn peer(app: &AppHandle) -> tauri::State<'_, Peer> {
    app.state::<Peer>()
}

pub fn enabled(app: &AppHandle) -> bool {
    db::get_setting(&conn_of(app), "peer.enabled").ok().flatten().as_deref() == Some("1")
}

/// This PC's id for phones (made once).
pub fn desk_id(app: &AppHandle) -> String {
    let conn = conn_of(app);
    if let Some(id) = db::get_setting(&conn, "peer.deskId").ok().flatten().filter(|s| !s.is_empty()) {
        return id;
    }
    let id = crate::marks::new_uuid();
    let _ = db::set_setting(&conn, "peer.deskId", &id);
    id
}

/// The name phones see (the PC's name).
pub fn desk_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Katana Desk".into())
}

/// This PC's address on the network it reaches others through (no packet is sent).
fn lan_address() -> Option<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.168.0.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

/// At start: the server runs if he left it on.
pub fn start_if_on(app: &AppHandle) {
    if enabled(app) {
        if let Err(e) = start(app) {
            eprintln!("katana: sync on this Wi-Fi didn't start: {e}");
        }
    }
}

fn start(app: &AppHandle) -> Result<(), String> {
    let st = peer(app);
    let mut running = st.running.lock().unwrap();
    if running.is_some() {
        return Ok(());
    }
    // KATANA_PEER_BIND=127.0.0.1: test runs answer on this PC only (an emulator reaches it as 10.0.2.2),
    // with no mDNS, so Windows doesn't ask about its firewall
    let bind = std::env::var("KATANA_PEER_BIND").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "0.0.0.0".into());
    let everywhere = bind == "0.0.0.0";
    let server = match tiny_http::Server::http((bind.as_str(), PORT)) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            let msg = format!("Port {PORT} is taken by another program ({e})");
            *st.error.lock().unwrap() = Some(msg.clone());
            return Err(msg);
        }
    };
    *st.error.lock().unwrap() = None;
    let srv = server.clone();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("katana-peer".into())
        .spawn(move || {
            for req in srv.incoming_requests() {
                let app = handle.clone();
                std::thread::spawn(move || api::handle(&app, req));
            }
        })
        .map_err(|e| e.to_string())?;
    let mdns = if everywhere { advertise(app).map_err(|e| eprintln!("katana: mDNS: {e}")).ok() } else { None };
    *running = Some(Running { server, mdns });
    Ok(())
}

fn advertise(app: &AppHandle) -> Result<(mdns_sd::ServiceDaemon, String), String> {
    let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
    let name = desk_name();
    let host: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    let id = desk_id(app);
    let props = [("id", id.as_str()), ("v", "1")];
    let info = mdns_sd::ServiceInfo::new(SERVICE, &name, &format!("{host}.local."), "", PORT, &props[..])
        .map_err(|e| e.to_string())?
        .enable_addr_auto();
    let full = info.get_fullname().to_string();
    daemon.register(info).map_err(|e| e.to_string())?;
    Ok((daemon, full))
}

fn stop(app: &AppHandle) {
    let st = peer(app);
    if let Some(r) = st.running.lock().unwrap().take() {
        r.server.unblock();
        if let Some((daemon, full)) = r.mdns {
            let _ = daemon.unregister(&full);
            let _ = daemon.shutdown();
        }
    }
    st.pairing.lock().unwrap().close();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerStatus {
    enabled: bool,
    running: bool,
    error: Option<String>,
    port: u16,
    name: String,
    address: Option<String>,
    code: Option<String>,
    code_until: Option<i64>,
    devices: Vec<Device>,
}

fn status_of(app: &AppHandle) -> PeerStatus {
    let st = peer(app);
    let now = db::now();
    let code = st.pairing.lock().unwrap().current(now);
    let running = st.running.lock().unwrap().is_some();
    let error = st.error.lock().unwrap().clone();
    PeerStatus {
        enabled: enabled(app),
        running,
        error,
        port: PORT,
        name: desk_name(),
        address: lan_address(),
        code: code.as_ref().map(|c| c.0.clone()),
        code_until: code.map(|c| c.1),
        devices: pair::devices(&conn_of(app)),
    }
}

pub fn changed(app: &AppHandle) {
    let _ = app.emit("peer-changed", ());
}

#[tauri::command]
pub fn peer_status(app: AppHandle) -> PeerStatus {
    status_of(&app)
}

/// Settings › Sync on this Wi-Fi.
#[tauri::command]
pub fn peer_set_enabled(app: AppHandle, on: bool) -> PeerStatus {
    let _ = db::set_setting(&conn_of(&app), "peer.enabled", if on { "1" } else { "0" });
    if on {
        let _ = start(&app);
    } else {
        stop(&app);
    }
    status_of(&app)
}

/// "Pair a device": a new code, good for 5 minutes.
#[tauri::command]
pub fn peer_pair_open(app: AppHandle) -> PeerStatus {
    peer(&app).pairing.lock().unwrap().open(db::now());
    status_of(&app)
}

#[tauri::command]
pub fn peer_pair_close(app: AppHandle) -> PeerStatus {
    peer(&app).pairing.lock().unwrap().close();
    status_of(&app)
}

/// Forget a device: its token stops working at once.
#[tauri::command]
pub fn peer_forget(app: AppHandle, device_id: String) -> PeerStatus {
    let _ = pair::forget(&conn_of(&app), &device_id);
    status_of(&app)
}

/// The reader's answer to a phone's place (from `grimmory_answer`): go there, or stay (this PC's place
/// is then what phones see).
pub fn answer(app: &AppHandle, id: i64, p: &ServerPlace, go: bool) {
    if go {
        api::take_place(app, id, p);
    } else {
        let now = db::now();
        let _ = conn_of(app).execute(
            "UPDATE books SET peer_served_at = ?2, peer_synced_at = ?2 WHERE id = ?1",
            rusqlite::params![id, now],
        );
    }
}
