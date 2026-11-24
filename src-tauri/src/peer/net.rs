//! Which of this PC's addresses a phone on the Wi-Fi reaches it on, to show on the pairing screen. A
//! Windows PC often has more than its Wi-Fi or cable: VirtualBox's host-only network (192.168.56.1),
//! WSL's and Hyper-V's vEthernet (172.x), a VPN, Windows' own link-local leftovers (169.254.x). The
//! address shown is, in order: the one on the same network as the last phone that called (its own
//! address in that network's range), the one the PC's own route out to the internet uses, or the most
//! home-like private address whose name doesn't say it's virtual.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};

/// One IPv4 address of this PC, with its network's mask and the adapter's name.
#[derive(Clone, Debug, PartialEq)]
pub struct Iface {
    pub name: String,
    pub ip: Ipv4Addr,
    pub mask: Ipv4Addr,
}

impl Iface {
    /// Whether `other` is on this address's network.
    pub fn holds(&self, other: Ipv4Addr) -> bool {
        let m = u32::from(self.mask);
        m != 0 && (u32::from(self.ip) & m) == (u32::from(other) & m)
    }
}

/// Private (RFC 1918) and not link-local or loopback: an address a phone on a home network can reach.
pub fn home_like(ip: Ipv4Addr) -> bool {
    ip.is_private() && !ip.is_loopback() && !ip.is_link_local()
}

/// Adapter names that are a virtual network on this PC, not the Wi-Fi or cable a phone is on.
pub fn sounds_virtual(name: &str) -> bool {
    const WORDS: [&str; 16] = [
        "vethernet", "virtualbox", "vmware", "vmnet", "hyper-v", "wsl", "docker", "tailscale", "zerotier",
        "hamachi", "radmin", "wireguard", "wintun", "tap-", "npcap", "loopback",
    ];
    let n = name.to_ascii_lowercase();
    WORDS.iter().any(|w| n.contains(w)) || n.contains("bluetooth") || n.contains("vpn")
}

/// This PC's addresses a phone could use (IPv4, private, not link-local), from the system.
pub fn ifaces() -> Vec<Iface> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) if home_like(v4.ip) => Some(Iface { name: i.name.clone(), ip: v4.ip, mask: v4.netmask }),
            _ => None,
        })
        .collect()
}

/// The address this PC's own route out uses (no packet is sent: a UDP "connect" only picks the route).
pub fn route_ip() -> Option<Ipv4Addr> {
    ["8.8.8.8:53", "192.168.0.1:9"].iter().find_map(|to| {
        let s = UdpSocket::bind("0.0.0.0:0").ok()?;
        s.connect(to).ok()?;
        match s.local_addr().ok()?.ip() {
            IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
            _ => None,
        }
    })
}

/// The address to show (see the module's note). `phone`: the last phone's own address, when one called
/// from another machine (an emulator on this PC calls from 127.0.0.1 and says nothing).
pub fn pick(ifaces: &[Iface], route: Option<Ipv4Addr>, phone: Option<Ipv4Addr>) -> Option<Ipv4Addr> {
    if let Some(p) = phone.filter(|p| home_like(*p)) {
        // the narrowest network holding the phone (a /24 over a /16)
        if let Some(i) = ifaces.iter().filter(|i| i.holds(p)).max_by_key(|i| u32::from(i.mask).count_ones()) {
            return Some(i.ip);
        }
    }
    if let Some(r) = route.filter(|r| ifaces.iter().any(|i| i.ip == *r && !sounds_virtual(&i.name))) {
        return Some(r);
    }
    let rank = |ip: Ipv4Addr| match ip.octets() {
        [192, 168, ..] => 0,
        [10, ..] => 1,
        _ => 2,
    };
    ifaces
        .iter()
        .filter(|i| !sounds_virtual(&i.name))
        .min_by_key(|i| rank(i.ip))
        .map(|i| i.ip)
        .or_else(|| route.filter(|r| home_like(*r)))
}

/// The address to show now.
pub fn lan_address(phone: Option<Ipv4Addr>) -> Option<Ipv4Addr> {
    pick(&ifaces(), route_ip(), phone)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn i(name: &str, ip: [u8; 4], mask: [u8; 4]) -> Iface {
        Iface { name: name.into(), ip: Ipv4Addr::from(ip), mask: Ipv4Addr::from(mask) }
    }

    // this PC as it is (2026-11-24): VirtualBox's host-only network beside the Wi-Fi
    fn here() -> Vec<Iface> {
        vec![i("Ethernet 3", [192, 168, 56, 1], [255, 255, 255, 0]), i("WiFi", [192, 168, 100, 199], [255, 255, 255, 0])]
    }

    #[test]
    fn the_phones_network_wins() {
        let phone = Some(Ipv4Addr::new(192, 168, 100, 23));
        assert_eq!(pick(&here(), None, phone), Some(Ipv4Addr::new(192, 168, 100, 199)));
        // even when the route out says otherwise (a VPN)
        assert_eq!(pick(&here(), Some(Ipv4Addr::new(192, 168, 56, 1)), phone), Some(Ipv4Addr::new(192, 168, 100, 199)));
    }

    #[test]
    fn without_a_phone_the_route_out_decides() {
        assert_eq!(pick(&here(), Some(Ipv4Addr::new(192, 168, 100, 199)), None), Some(Ipv4Addr::new(192, 168, 100, 199)));
    }

    #[test]
    fn an_emulator_on_this_pc_says_nothing() {
        let route = Some(Ipv4Addr::new(192, 168, 100, 199));
        assert_eq!(pick(&here(), route, Some(Ipv4Addr::LOCALHOST)), Some(Ipv4Addr::new(192, 168, 100, 199)));
    }

    #[test]
    fn virtual_adapters_are_skipped() {
        let ifs = vec![
            i("vEthernet (WSL (Hyper-V firewall))", [172, 23, 80, 1], [255, 255, 240, 0]),
            i("Ethernet", [10, 0, 0, 12], [255, 255, 255, 0]),
            i("Tailscale", [100, 101, 1, 2], [255, 192, 0, 0]),
        ];
        // a route through the VPN or WSL doesn't count
        assert_eq!(pick(&ifs, Some(Ipv4Addr::new(172, 23, 80, 1)), None), Some(Ipv4Addr::new(10, 0, 0, 12)));
        assert_eq!(pick(&ifs, None, None), Some(Ipv4Addr::new(10, 0, 0, 12)));
    }

    #[test]
    fn a_phone_off_every_network_here_falls_back() {
        let phone = Some(Ipv4Addr::new(10, 9, 9, 9));
        assert_eq!(pick(&here(), Some(Ipv4Addr::new(192, 168, 100, 199)), phone), Some(Ipv4Addr::new(192, 168, 100, 199)));
    }

    #[test]
    fn home_like_addresses() {
        assert!(home_like(Ipv4Addr::new(192, 168, 1, 5)));
        assert!(home_like(Ipv4Addr::new(10, 0, 2, 2)));
        assert!(!home_like(Ipv4Addr::new(169, 254, 4, 117)));
        assert!(!home_like(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!home_like(Ipv4Addr::new(8, 8, 8, 8)));
    }

    #[test]
    fn names_that_sound_virtual() {
        for n in ["vEthernet (WSL)", "VirtualBox Host-Only Network", "VMware Network Adapter VMnet8", "Tailscale", "ZeroTier One", "Bluetooth Network Connection", "NordVPN"] {
            assert!(sounds_virtual(n), "{n}");
        }
        for n in ["WiFi", "Wi-Fi", "Ethernet", "Ethernet 3", "WLAN"] {
            assert!(!sounds_virtual(n), "{n}");
        }
    }
}
