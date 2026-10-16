"""Fake Feeder Tool — Machine Data Simulator (Node-RED / ESP32 Simulator)

Sends periodic machine data packets via HTTP POST to the backend endpoint `/api/ingest`.
Use this script to test the OEE backend without physical ESP32 hardware.

Usage:
    python tools/fake_feeder.py
    python tools/fake_feeder.py --l1-state RUNNING --l2-state STOP
    python tools/fake_feeder.py --emg1
"""

import argparse
import json
import random
import sys
import time
import urllib.error
import urllib.request


def send_packet(url: str, payload: dict) -> bool:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            return resp.status == 200
    except Exception as e:
        print(f"[feeder] Failed to send packet to {url}: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="OEE Fake Feeder (Node-RED Simulator)")
    parser.add_argument("--url", default="http://127.0.0.1:8000/api/ingest", help="Ingest endpoint URL")
    parser.add_argument("--rate", type=float, default=1.0, help="Packet interval (seconds)")
    parser.add_argument("--l1-state", default="RUNNING", choices=["RUNNING", "STOP", "IDLE"], help="Line 1 state")
    parser.add_argument("--l2-state", default="RUNNING", choices=["RUNNING", "STOP", "IDLE"], help="Line 2 state")
    parser.add_argument("--emg1", action="store_true", help="Simulate Emergency Stop on Line 1")
    parser.add_argument("--emg2", action="store_true", help="Simulate Emergency Stop on Line 2")
    parser.add_argument("--disconnected", action="store_true", help="Simulate ESP32 disconnected state")
    args = parser.parse_args()

    print("=" * 60)
    print("OEE Fake Feeder running...")
    print(f"Target URL : {args.url}")
    print(f"Interval   : {args.rate}s")
    print(f"Line 1     : {args.l1_state} (EMG={args.emg1})")
    print(f"Line 2     : {args.l2_state} (EMG={args.emg2})")
    print("Press Ctrl+C to stop")
    print("=" * 60)

    t1 = 30.2
    t2 = 31.0
    tick_count = 0

    try:
        while True:
            tick_count += 1
            t1 = round(min(36.0, max(27.0, t1 + random.uniform(-0.15, 0.15))), 1)
            t2 = round(min(36.0, max(27.0, t2 + random.uniform(-0.15, 0.15))), 1)

            # Product detection probability: approx every 10-15 seconds
            l1_good = 1 if (args.l1_state == "RUNNING" and random.random() < 0.12) else 0
            l1_reject = 1 if (l1_good and random.random() < 0.15) else 0
            if l1_reject:
                l1_good = 0

            l2_good = 1 if (args.l2_state == "RUNNING" and random.random() < 0.10) else 0
            l2_reject = 1 if (l2_good and random.random() < 0.15) else 0
            if l2_reject:
                l2_good = 0

            payload = {
                "ts_ms": int(time.time() * 1000),
                "esp32_connected": not args.disconnected,
                "line1": {
                    "state": args.l1_state,
                    "emg": args.emg1,
                    "temp_c": t1,
                    "good_delta": l1_good,
                    "reject_delta": l1_reject,
                    "last_mm": random.randint(120, 200) if l1_good else 0,
                },
                "line2": {
                    "state": args.l2_state,
                    "emg": args.emg2,
                    "temp_c": t2,
                    "good_delta": l2_good,
                    "reject_delta": l2_reject,
                    "last_mm": random.randint(120, 200) if l2_good else 0,
                },
            }

            ok = send_packet(args.url, payload)
            status_char = "OK" if ok else "ERR"
            print(
                f"[{status_char}] #{tick_count:04d} | L1: {args.l1_state} ({t1}°C, +G:{l1_good}, +R:{l1_reject}) "
                f"| L2: {args.l2_state} ({t2}°C, +G:{l2_good}, +R:{l2_reject})"
            )
            time.sleep(args.rate)
    except KeyboardInterrupt:
        print("\nFake feeder stopped.")


if __name__ == "__main__":
    main()
