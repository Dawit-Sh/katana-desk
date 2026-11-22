//! Finds Grimmory on this PC's network for the first sign-in, so the server's address fills in by itself:
//! every address of this PC's own network (each /24 it is on, home networks only) is asked, on Grimmory's
//! port 6060 and nearest first, for Grimmory's health check, which answers without a sign-in:
//! `{"data":{"status":"UP",...},"message":"Pong"}`. A few seconds; a network still waking up (a PC just
//! back from sleep, Wi-Fi joining) gets two more tries. Nothing found, the field stays as it was and he
//! types the address as before. The same way Katana finds it on a phone (`GrimmoryOnThisWifi.kt`).

use futures_util::{stream, StreamExt};
use std::net::Ipv4Addr;
use std::time::Duration;

pub const PORT: u16 = 6060;
const PARALLEL: usize = 48;

/// Whether `body` is Grimmory's health check answer.
pub fn is_health(body: &str) -> bool {
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    compact.contains("\"Pong\"") && compact.contains("\"status\":\"UP\"")
}

/// A home network's address (10.x, 172.16-31.x, 192.168.x), not this PC talking to itself or an address
/// a network hands out when nothing answered (169.254.x).
pub fn worth_looking(a: Ipv4Addr) -> bool {
    a.is_private() && !a.is_loopback() && !a.is_link_local()
}

/// The other addresses of `own`'s /24 network, 1 to 254, nearest first (a home server sits near).
pub fn hosts_near(own: Ipv4Addr) -> Vec<Ipv4Addr> {
    let [a, b, c, d] = own.octets();
    let mut v: Vec<u8> = (1..=254).filter(|h| *h != d).collect();
    v.sort_by_key(|h| ((*h as i32) - (d as i32)).abs());
    v.into_iter().map(|h| Ipv4Addr::new(a, b, c, h)).collect()
}

/// This PC's own addresses worth looking around, one per /24, 192.168.x first (home Wi-Fi), then 10.x and
/// 172.x (often a virtual network of Windows' own).
pub fn own_addresses() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = vec![];
    for i in if_addrs::get_if_addrs().unwrap_or_default() {
        if let std::net::IpAddr::V4(a) = i.ip() {
            if worth_looking(a) && !out.iter().any(|o| o.octets()[..3] == a.octets()[..3]) {
                out.push(a);
            }
        }
    }
    out.sort_by_key(|a| match a.octets()[0] {
        192 => 0,
        10 => 1,
        _ => 2,
    });
    out
}

fn prober() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(400))
        .timeout(Duration::from_millis(1500))
        .no_proxy()
        .user_agent(concat!("KatanaDesk/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

/// Whether Grimmory answers at `base` (http://host:port).
pub async fn answers(client: &reqwest::Client, base: &str) -> bool {
    match client.get(format!("{}/api/v1/healthcheck", base.trim_end_matches('/'))).send().await {
        Ok(r) if r.status().is_success() => r.text().await.map(|t| is_health(&t)).unwrap_or(false),
        _ => false,
    }
}

/// One look round this PC's networks: Grimmory's address, or none.
pub async fn find_once(saved: Option<&str>) -> Option<String> {
    let client = prober();
    if let Some(s) = saved.filter(|s| !s.trim().is_empty()) {
        if answers(&client, s).await {
            return Some(s.trim_end_matches('/').to_string());
        }
    }
    let hosts: Vec<Ipv4Addr> = own_addresses().into_iter().flat_map(hosts_near).collect();
    stream::iter(hosts)
        .map(move |h| {
            let c = client.clone();
            async move {
                let base = format!("http://{h}:{PORT}");
                answers(&c, &base).await.then_some(base)
            }
        })
        .buffered(PARALLEL)
        .filter_map(|x| async move { x })
        .boxed()
        .next()
        .await
}

/// The waits before each look: at once, then after 2 s and 4 s more, for a network that's still waking.
pub const TRIES: [u64; 3] = [0, 2, 4];

/// Looks for Grimmory on this PC's network (the saved address first, if any). Its address, or none.
#[tauri::command]
pub async fn grimmory_find(saved: Option<String>) -> Option<String> {
    for wait in TRIES {
        tokio::time::sleep(Duration::from_secs(wait)).await;
        if let Some(found) = find_once(saved.as_deref()).await {
            return Some(found);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_grimmorys_own_health_check_counts() {
        assert!(is_health(r#"{"data":{"status":"UP","message":"Application is running smoothly.","version":"v3.5.0"},"message":"Pong"}"#));
        assert!(is_health("{\"data\": {\"status\": \"UP\"}, \"message\": \"Pong\"}"));
        // another server's health check, a router's page
        assert!(!is_health(r#"{"groups":["liveness","readiness"],"status":"UP"}"#));
        assert!(!is_health("<html><title>Router</title></html>"));
    }

    #[test]
    fn the_neighbours_come_nearest_first_on_the_same_network_only() {
        let hosts = hosts_near(Ipv4Addr::new(192, 168, 100, 104));
        assert_eq!(hosts.len(), 253);
        assert!(!hosts.contains(&Ipv4Addr::new(192, 168, 100, 104)));
        let mut first: Vec<_> = hosts[..2].to_vec();
        first.sort();
        assert_eq!(first, vec![Ipv4Addr::new(192, 168, 100, 103), Ipv4Addr::new(192, 168, 100, 105)]);
        assert!(hosts[..8].contains(&Ipv4Addr::new(192, 168, 100, 100)));
        assert!(hosts.iter().all(|h| h.octets()[..3] == [192, 168, 100] && h.octets()[3] != 0 && h.octets()[3] != 255));
    }

    #[test]
    fn home_networks_only() {
        assert!(worth_looking(Ipv4Addr::new(192, 168, 1, 20)));
        assert!(worth_looking(Ipv4Addr::new(10, 0, 0, 5)));
        assert!(!worth_looking(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!worth_looking(Ipv4Addr::new(169, 254, 3, 4)));
        assert!(!worth_looking(Ipv4Addr::new(8, 8, 8, 8)));
    }

    #[test]
    fn finds_grimmory_where_it_answers() {
        // a tiny Grimmory health check on this PC
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for s in listener.incoming().take(2) {
                let mut s = s.unwrap();
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let body = r#"{"data":{"status":"UP"},"message":"Pong"}"#;
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let base = format!("http://127.0.0.1:{port}");
        assert_eq!(rt.block_on(find_once(Some(&base))), Some(base.clone()));
        assert!(!rt.block_on(answers(&prober(), "http://127.0.0.1:9")));
    }
}
