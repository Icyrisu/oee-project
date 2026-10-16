import socket

def get_network_info() -> dict:
    """Mendeteksi IP aktual Raspberry Pi: wlan0 (Hotspot) dan eth0 (kabel LAN)."""
    lan_ip = None
    hotspot_ip = "10.42.0.1"

    # 1. Pada Linux (Raspberry Pi), baca eth0/end0 dan wlan0 via ioctl
    try:
        import fcntl
        import struct

        def if_ip(ifname: str):
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                return socket.inet_ntoa(fcntl.ioctl(
                    s.fileno(),
                    0x8915,  # SIOCGIFADDR
                    struct.pack("256s", ifname[:15].encode("utf-8")),
                )[20:24])
            except Exception:
                return None

        eth = if_ip("eth0") or if_ip("end0")
        if eth and not eth.startswith("127."):
            lan_ip = eth

        wlan = if_ip("wlan0")
        if wlan and not wlan.startswith("127."):
            hotspot_ip = wlan
    except Exception:
        pass

    # 2. Fallback untuk non-Linux / Windows development
    if not lan_ip:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            if ip and not ip.startswith("127.") and ip != hotspot_ip:
                lan_ip = ip
        except Exception:
            pass

    return {
        "lan_ip": lan_ip,
        "hotspot_ip": hotspot_ip,
        "hostname": "pi.local",
    }
