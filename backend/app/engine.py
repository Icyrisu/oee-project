import sqlite3
import time
from datetime import datetime
from typing import Dict, Optional
from .config import CHECKPOINT_INTERVAL_SEC, LABEL_FMT, LINE_IDS, LINK_TIMEOUT_SEC
from .oee import compute_metrics
from .repository import (
    checkpoint_session,
    create_session,
    finish_session,
    get_active_session,
    get_all_settings,
    log_state_change,
    update_setting,
)
from .schemas import IngestPayload, SettingsUpdate


class Engine:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.session_id: Optional[int] = None
        self.session_active: bool = False
        self.session_started_at: Optional[datetime] = None
        self.session_seconds: int = 0
        self.is_online: bool = False
        self.last_packet_time: Optional[float] = None
        self.recovery_pending: bool = False
        self.recovery_session: Optional[dict] = None
        self._last_checkpoint_sec: int = 0

        self.lines: Dict[int, dict] = {
            1: self._new_line(target=10, cycle_time=60.0, planned_seconds=0, temp_c=30.0),
            2: self._new_line(target=30, cycle_time=60.0, planned_seconds=0, temp_c=30.0),
        }

    def _new_line(self, target: int, cycle_time: float, planned_seconds: int, temp_c: float) -> dict:
        return {
            "status": "IDLE",
            "temp_c": temp_c,
            "good": 0,
            "reject": 0,
            "target": target,
            "cycle_time": cycle_time,
            "planned_seconds": planned_seconds,
            "run_seconds": 0,
            "emg": False,
        }

    def startup(self) -> None:
        """Memuat pengaturan dari SQLite dan memeriksa pemulihan sesi terputus."""
        settings = get_all_settings(self.conn)
        for lid in LINE_IDS:
            if lid in settings:
                s = settings[lid]
                self.lines[lid]["target"] = s["target"]
                self.lines[lid]["cycle_time"] = s["cycle_time"]
                self.lines[lid]["planned_seconds"] = s["planned_seconds"]

        # Periksa apakah ada sesi yang belum diakhiri (mis. Raspi mati mendadak)
        active_row = get_active_session(self.conn)
        if active_row:
            self.recovery_pending = True
            self.recovery_session = {
                "id": active_row["id"],
                "label": active_row["session_label"],
                "started_at": active_row["started_at"],
                "elapsed_sec": active_row["elapsed_sec"] or 0,
                "l1_good": active_row["l1_good"] or 0,
                "l1_reject": active_row["l1_reject"] or 0,
                "l1_run_sec": active_row["l1_run_sec"] or 0,
                "l2_good": active_row["l2_good"] or 0,
                "l2_reject": active_row["l2_reject"] or 0,
                "l2_run_sec": active_row["l2_run_sec"] or 0,
            }

    def handle_recovery(self, action: str) -> dict:
        """Menangani keputusan operator untuk memulihkan atau mengakhiri sesi terputus."""
        if not self.recovery_pending or not self.recovery_session:
            return self.snapshot()

        rec = self.recovery_session
        if action == "resume":
            self.session_id = rec["id"]
            self.session_active = True
            self.session_seconds = rec["elapsed_sec"]
            try:
                self.session_started_at = datetime.fromisoformat(rec["started_at"])
            except Exception:
                self.session_started_at = datetime.now()

            self.lines[1]["good"] = rec["l1_good"]
            self.lines[1]["reject"] = rec["l1_reject"]
            self.lines[1]["run_seconds"] = rec["l1_run_sec"]
            self.lines[2]["good"] = rec["l2_good"]
            self.lines[2]["reject"] = rec["l2_reject"]
            self.lines[2]["run_seconds"] = rec["l2_run_sec"]

            self.recovery_pending = False
            self.recovery_session = None
        elif action == "end":
            # Hitung metrik final dan akhiri sesi di SQLite
            l1 = self.lines[1]
            l2 = self.lines[2]
            l1_m = compute_metrics(
                rec["l1_good"], rec["l1_reject"], rec["l1_run_sec"],
                l1["cycle_time"], l1["planned_seconds"], rec["elapsed_sec"]
            )
            l2_m = compute_metrics(
                rec["l2_good"], rec["l2_reject"], rec["l2_run_sec"],
                l2["cycle_time"], l2["planned_seconds"], rec["elapsed_sec"]
            )
            finish_session(
                self.conn,
                session_id=rec["id"],
                ended_at=datetime.now().isoformat(timespec="seconds"),
                elapsed_sec=rec["elapsed_sec"],
                l1={"good": rec["l1_good"], "reject": rec["l1_reject"], "run_seconds": rec["l1_run_sec"]},
                l2={"good": rec["l2_good"], "reject": rec["l2_reject"], "run_seconds": rec["l2_run_sec"]},
                l1_m=l1_m,
                l2_m=l2_m,
            )
            self.recovery_pending = False
            self.recovery_session = None

        return self.snapshot()

    def ingest(self, payload: IngestPayload) -> None:
        """Menerima paket data mesin dari Node-RED (atau feeder penguji)."""
        now = time.monotonic()
        self.last_packet_time = now
        self.is_online = bool(payload.esp32_connected)

        line_payloads = {1: payload.line1, 2: payload.line2}
        now_iso = datetime.now().isoformat(timespec="seconds")

        for lid in LINE_IDS:
            lp = line_payloads.get(lid)
            if not lp:
                continue

            ln = self.lines[lid]
            if lp.temp_c is not None:
                ln["temp_c"] = round(float(lp.temp_c), 1)

            old_status = ln["status"]

            # Logika Emergency Stop: jika aktif, mesin wajib STOP
            if lp.emg:
                ln["emg"] = True
                new_status = "STOP"
            else:
                ln["emg"] = False
                if not self.session_active:
                    # Sesi belum start di web -> status mesin tetap IDLE
                    new_status = "IDLE"
                else:
                    # Sesi aktif -> ikuti perintah hardware ESP32 (RUNNING/STOP/IDLE)
                    new_status = lp.state if lp.state else ln["status"]

            ln["status"] = new_status
            if new_status != old_status:
                log_state_change(self.conn, self.session_id, lid, new_status, ln["temp_c"], now_iso)

            # Tambahkan delta produksi hanya jika sesi sedang aktif
            if self.session_active:
                if lp.good_delta and lp.good_delta > 0:
                    ln["good"] += int(lp.good_delta)
                if lp.reject_delta and lp.reject_delta > 0:
                    ln["reject"] += int(lp.reject_delta)

    def tick(self) -> dict:
        """Dipanggil setiap 1 detik oleh background loop aplikasi."""
        now = time.monotonic()

        # Periksa koneksi ESP32
        if self.last_packet_time is None or (now - self.last_packet_time) > LINK_TIMEOUT_SEC:
            self.is_online = False
            for ln in self.lines.values():
                ln["status"] = "IDLE"
        else:
            self.is_online = True

        # Tambahkan waktu jika sesi aktif
        if self.session_active:
            self.session_seconds += 1

            for ln in self.lines.values():
                # Run time hanya bertambah jika ESP32 online dan line sedang RUNNING
                if self.is_online and ln["status"] == "RUNNING":
                    ln["run_seconds"] += 1

            # Checkpoint berkala ke SQLite untuk perlindungan data saat mati listrik
            if (self.session_seconds - self._last_checkpoint_sec) >= CHECKPOINT_INTERVAL_SEC:
                self._save_checkpoint()
                self._last_checkpoint_sec = self.session_seconds

        return self.snapshot()

    def _save_checkpoint(self) -> None:
        if not self.session_id or not self.session_active:
            return
        m1 = compute_metrics(
            self.lines[1]["good"], self.lines[1]["reject"], self.lines[1]["run_seconds"],
            self.lines[1]["cycle_time"], self.lines[1]["planned_seconds"], self.session_seconds
        )
        m2 = compute_metrics(
            self.lines[2]["good"], self.lines[2]["reject"], self.lines[2]["run_seconds"],
            self.lines[2]["cycle_time"], self.lines[2]["planned_seconds"], self.session_seconds
        )
        checkpoint_session(
            self.conn, self.session_id, self.session_seconds,
            self.lines[1], self.lines[2], m1, m2
        )

    def start_session(self) -> None:
        """Starts a new production session."""
        if not self.is_online:
            raise ValueError("Cannot start session while machine is offline")
        self.session_seconds = 0
        self._last_checkpoint_sec = 0
        self.session_active = True
        self.session_started_at = datetime.now()

        # Reset counters mesin
        for ln in self.lines.values():
            ln["good"] = 0
            ln["reject"] = 0
            ln["run_seconds"] = 0
            ln["status"] = "IDLE"  # Menunggu operator menekan PB1 pada hardware

        label = self.session_started_at.strftime(LABEL_FMT)
        self.session_id = create_session(
            self.conn,
            label=label,
            started_at=self.session_started_at.isoformat(timespec="seconds"),
            l1_settings=self.lines[1],
            l2_settings=self.lines[2],
        )

    def stop_session(self) -> None:
        """Mengakhiri sesi produksi dan menyimpannya secara permanen ke database."""
        if self.session_active and self.session_id:
            ended_at = datetime.now().isoformat(timespec="seconds")
            m1 = compute_metrics(
                self.lines[1]["good"], self.lines[1]["reject"], self.lines[1]["run_seconds"],
                self.lines[1]["cycle_time"], self.lines[1]["planned_seconds"], self.session_seconds
            )
            m2 = compute_metrics(
                self.lines[2]["good"], self.lines[2]["reject"], self.lines[2]["run_seconds"],
                self.lines[2]["cycle_time"], self.lines[2]["planned_seconds"], self.session_seconds
            )
            finish_session(
                self.conn, self.session_id, ended_at, self.session_seconds,
                self.lines[1], self.lines[2], m1, m2
            )

        self.session_active = False
        self.session_id = None
        self.session_started_at = None
        for ln in self.lines.values():
            ln["status"] = "IDLE"

    def toggle_session(self) -> dict:
        if self.session_active:
            self.stop_session()
        else:
            self.start_session()
        return self.snapshot()

    def update_line_setting(self, line_id: int, payload: SettingsUpdate) -> dict:
        if self.session_active:
            raise ValueError("Settings are locked during an active production session. Please end the session first.")
        updated = update_setting(
            self.conn,
            line_id=line_id,
            target=payload.target,
            cycle_time=payload.cycle_time,
            planned_seconds=payload.planned_seconds,
        )
        ln = self.lines[line_id]
        if payload.target is not None:
            ln["target"] = payload.target
        if payload.cycle_time is not None:
            ln["cycle_time"] = payload.cycle_time
        if payload.planned_seconds is not None:
            ln["planned_seconds"] = payload.planned_seconds

        return self.snapshot()

    def snapshot(self) -> dict:
        """Menghasilkan snapshot lengkap yang dikirim ke frontend via REST dan WebSocket."""
        started = self.session_started_at
        secs = self.session_seconds

        lines_out = []
        for lid in LINE_IDS:
            ln = self.lines[lid]
            metrics = compute_metrics(
                good=ln["good"],
                reject=ln["reject"],
                run_seconds=ln["run_seconds"],
                cycle_time=ln["cycle_time"],
                planned_seconds=ln["planned_seconds"],
                elapsed_seconds=secs,
            )
            lines_out.append({
                "id": lid,
                "status": ln["status"],
                "temp_c": ln["temp_c"],
                "good": ln["good"],
                "reject": ln["reject"],
                "target": ln["target"],
                "cycle_time": ln["cycle_time"],
                "planned_seconds": ln["planned_seconds"],
                "run_seconds": ln["run_seconds"],
                **metrics,
            })

        return {
            "type": "state",
            "server_time": datetime.now().isoformat(timespec="seconds"),
            "session_active": self.session_active,
            "session_label": started.strftime(LABEL_FMT) if started else None,
            "session_seconds": secs,
            "is_online": self.is_online,
            "recovery_pending": self.recovery_pending,
            "recovery_session": self.recovery_session,
            "lines": lines_out,
        }
