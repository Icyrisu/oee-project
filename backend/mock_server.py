"""
OEE Monitoring — Mock Backend (Tahap 1)
=======================================

Server FastAPI *in-memory* yang menyuplai data tiruan untuk frontend SPA 480x320.

Aturan Tahap 1:
  * TANPA database — seluruh state disimpan di dictionary Python (hilang saat restart).
  * TANPA serial hardware — data disimulasikan oleh background loop ``asyncio.sleep(1)``.

Menjalankan:
    pip install -r backend/requirements.txt
    python backend/mock_server.py
    -> buka http://localhost:8000

Endpoint:
    WS   /ws                       broadcast snapshot state setiap 1 detik
    GET  /api/state                snapshot state saat ini
    POST /api/session/toggle       START <-> STOP sesi produksi
    POST /api/mock/toggle-state    (testing) ganti status mesin / koneksi / skenario
    GET  /api/sessions             daftar sesi mock untuk halaman Report
    PUT  /api/settings/{line_id}   ubah target & ideal cycle time
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import random
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Konstanta
# ---------------------------------------------------------------------------
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
TICK_SECONDS = 1.0
LINE_IDS = (1, 2)
LABEL_FMT = "%d-%m-%Y %H:%M:%S"
REJECT_RATE = 0.12          # peluang produk yang dihasilkan masuk kategori reject
SHIFT_SECONDS = 8 * 3600    # durasi sesi historis mock

LineStatus = Literal["RUNNING", "STOP", "IDLE"]
Connection = Literal["ONLINE", "OFFLINE"]
Scenario = Literal["both_running", "line2_stop", "both_stop", "idle_offline", "start_session"]


# ---------------------------------------------------------------------------
# State in-memory
# ---------------------------------------------------------------------------
def _new_line(target: int, cycle_time: int, temp_c: float) -> dict:
    return {
        "status": "IDLE",
        "temp_c": temp_c,
        "good": 0,
        "reject": 0,
        "target": target,
        "cycle_time": cycle_time,
        "run_seconds": 0,
    }


STATE: dict = {
    "session_active": False,
    "session_started_at": None,   # datetime | None
    "session_seconds": 0,
    "is_online": True,
    "lines": {
        1: _new_line(target=10, cycle_time=60, temp_c=30.2),
        2: _new_line(target=30, cycle_time=60, temp_c=31.0),
    },
}


def compute_metrics(line: dict, session_seconds: int) -> dict:
    """Hitung Availability, Performance, Quality, dan OEE (dalam persen)."""
    total = line["good"] + line["reject"]
    run = line["run_seconds"]
    availability = min(1.0, run / session_seconds) if session_seconds > 0 else 0.0
    performance = min(1.0, (line["cycle_time"] * total) / run) if run > 0 else 0.0
    quality = (line["good"] / total) if total > 0 else 0.0
    return {
        "availability": round(availability * 100, 1),
        "performance": round(performance * 100, 1),
        "quality": round(quality * 100, 1),
        "oee": round(availability * performance * quality * 100, 1),
    }


def snapshot() -> dict:
    started: Optional[datetime] = STATE["session_started_at"]
    secs = STATE["session_seconds"]
    return {
        "type": "state",
        "server_time": datetime.now().isoformat(timespec="seconds"),
        "session_active": STATE["session_active"],
        "session_label": started.strftime(LABEL_FMT) if started else None,
        "session_seconds": secs,
        "is_online": STATE["is_online"],
        "lines": [
            {"id": lid, **STATE["lines"][lid], **compute_metrics(STATE["lines"][lid], secs)}
            for lid in LINE_IDS
        ],
    }


# ---------------------------------------------------------------------------
# Riwayat sesi (mock)
# ---------------------------------------------------------------------------
def _hist_line(line_id: int, good: int, reject: int, avail: float, perf: float,
               quality: Optional[float] = None, oee: Optional[float] = None) -> dict:
    total = good + reject
    q = quality if quality is not None else (round(good / total * 100, 1) if total else 0.0)
    o = oee if oee is not None else round(avail * perf * q / 10000, 1)
    return {
        "id": line_id,
        "good": good,
        "reject": reject,
        "run_seconds": int(SHIFT_SECONDS * avail / 100),
        "availability": avail,
        "performance": perf,
        "quality": q,
        "oee": o,
    }


def _hist_session(session_id: int, started: datetime, lines: list[dict]) -> dict:
    ended = started + timedelta(seconds=SHIFT_SECONDS)
    return {
        "id": session_id,
        "label": started.strftime(LABEL_FMT),
        "started_at": started.isoformat(timespec="seconds"),
        "ended_at": ended.isoformat(timespec="seconds"),
        "duration_seconds": SHIFT_SECONDS,
        "lines": lines,
    }


def _seed_sessions() -> list[dict]:
    base = datetime(2026, 1, 1, 7, 0, 0)
    return [
        # Sesi acuan PDF — nilai literal sesuai spesifikasi (sub-state 7, 8, 9)
        _hist_session(1, base, [
            _hist_line(1, good=7, reject=2, avail=90.0, perf=80.5, quality=70.0, oee=88.5),
            _hist_line(2, good=6, reject=1, avail=85.0, perf=75.5, quality=85.7, oee=79.2),
        ]),
        _hist_session(2, base + timedelta(hours=8), [
            _hist_line(1, good=24, reject=3, avail=92.0, perf=88.0),
            _hist_line(2, good=20, reject=4, avail=86.0, perf=81.0),
        ]),
        _hist_session(3, base + timedelta(days=1), [
            _hist_line(1, good=28, reject=1, avail=95.0, perf=90.0),
            _hist_line(2, good=22, reject=2, avail=88.0, perf=84.0),
        ]),
        _hist_session(4, base + timedelta(days=1, hours=8), [
            _hist_line(1, good=18, reject=4, avail=80.0, perf=76.0),
            _hist_line(2, good=25, reject=1, avail=93.0, perf=89.0),
        ]),
        _hist_session(5, base + timedelta(days=2), [
            _hist_line(1, good=26, reject=2, avail=94.0, perf=87.0),
            _hist_line(2, good=19, reject=3, avail=84.0, perf=79.0),
        ]),
    ]


SESSIONS: list[dict] = _seed_sessions()


def _archive_current_session() -> None:
    """Simpan sesi yang baru selesai ke daftar riwayat (in-memory)."""
    secs = STATE["session_seconds"]
    ended = datetime.now()
    started = STATE["session_started_at"] or (ended - timedelta(seconds=secs))
    lines = []
    for lid in LINE_IDS:
        ln = STATE["lines"][lid]
        lines.append({
            "id": lid,
            "good": ln["good"],
            "reject": ln["reject"],
            "run_seconds": ln["run_seconds"],
            **compute_metrics(ln, secs),
        })
    SESSIONS.append({
        "id": max((s["id"] for s in SESSIONS), default=0) + 1,
        "label": started.strftime(LABEL_FMT),
        "started_at": started.isoformat(timespec="seconds"),
        "ended_at": ended.isoformat(timespec="seconds"),
        "duration_seconds": secs,
        "lines": lines,
    })


# ---------------------------------------------------------------------------
# Operasi state
# ---------------------------------------------------------------------------
def _reset_counters() -> None:
    STATE["session_seconds"] = 0
    for ln in STATE["lines"].values():
        ln.update(good=0, reject=0, run_seconds=0)


def start_session() -> None:
    _reset_counters()
    STATE["session_active"] = True
    STATE["session_started_at"] = datetime.now()
    for ln in STATE["lines"].values():
        ln["status"] = "RUNNING" if STATE["is_online"] else "IDLE"


def stop_session(archive: bool = True) -> None:
    if STATE["session_active"] and archive and STATE["session_seconds"] > 0:
        _archive_current_session()
    STATE["session_active"] = False
    STATE["session_started_at"] = None
    for ln in STATE["lines"].values():
        ln["status"] = "IDLE"


def _seed_demo_counters() -> None:
    """Data contoh agar tampilan state 1–3 mirip PDF (mis. Good 7/10 pcs, Reject 2 pcs)."""
    STATE["session_active"] = True
    STATE["session_seconds"] = 600
    STATE["session_started_at"] = datetime.now() - timedelta(seconds=600)
    STATE["lines"][1].update(good=7, reject=2, run_seconds=570)
    STATE["lines"][2].update(good=8, reject=1, run_seconds=560)


def apply_scenario(name: str) -> None:
    lines = STATE["lines"]
    if name in ("both_running", "line2_stop", "both_stop"):
        STATE["is_online"] = True
        no_data = all(ln["good"] + ln["reject"] == 0 for ln in lines.values())
        if not STATE["session_active"] or no_data:
            _seed_demo_counters()
        s1, s2 = {
            "both_running": ("RUNNING", "RUNNING"),
            "line2_stop": ("RUNNING", "STOP"),
            "both_stop": ("STOP", "STOP"),
        }[name]
        lines[1]["status"], lines[2]["status"] = s1, s2
    elif name == "idle_offline":
        stop_session(archive=False)
        STATE["is_online"] = False
    elif name == "start_session":
        STATE["is_online"] = True
        start_session()


def apply_connection(conn: str) -> None:
    STATE["is_online"] = conn == "ONLINE"
    for ln in STATE["lines"].values():
        if not STATE["is_online"]:
            ln["status"] = "IDLE"            # ESP32 putus -> tidak ada data mesin
        elif STATE["session_active"] and ln["status"] == "IDLE":
            ln["status"] = "RUNNING"


def _tick() -> None:
    """Satu langkah simulasi (dipanggil tiap detik)."""
    for ln in STATE["lines"].values():
        ln["temp_c"] = round(min(36.0, max(27.5, ln["temp_c"] + random.uniform(-0.15, 0.15))), 1)

    if not STATE["session_active"]:
        return
    STATE["session_seconds"] += 1
    if not STATE["is_online"]:
        return

    for ln in STATE["lines"].values():
        if ln["status"] != "RUNNING":
            continue
        ln["run_seconds"] += 1
        # Peluang produksi per detik ~ 90% dari kecepatan ideal (1 / cycle_time)
        if random.random() < min(1.0, 0.9 / max(1, ln["cycle_time"])):
            if random.random() < REJECT_RATE:
                ln["reject"] += 1
            else:
                ln["good"] += 1


# ---------------------------------------------------------------------------
# WebSocket hub
# ---------------------------------------------------------------------------
class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        for ws in list(self.clients):
            try:
                await ws.send_json(payload)
            except Exception:
                self.disconnect(ws)


hub = Hub()


async def simulator_loop() -> None:
    while True:
        await asyncio.sleep(TICK_SECONDS)
        try:
            _tick()
        except Exception as exc:  # loop simulasi tidak boleh mati
            print(f"[simulator] error: {exc!r}")
        await hub.broadcast(snapshot())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(simulator_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


# ---------------------------------------------------------------------------
# Aplikasi FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="OEE Mock Backend (Tahap 1)", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ToggleStateBody(BaseModel):
    scenario: Optional[Scenario] = None
    line_id: Optional[int] = Field(None, ge=1, le=2)
    status: Optional[LineStatus] = None
    connection: Optional[Connection] = None


class SettingsBody(BaseModel):
    target: Optional[int] = Field(None, ge=1, le=9999)
    cycle_time: Optional[int] = Field(None, ge=1, le=9999)
    run_seconds: Optional[int] = Field(None, ge=0, le=864000)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await hub.connect(ws)
    try:
        await ws.send_json(snapshot())
        while True:
            await ws.receive_text()      # pesan dari klien diabaikan (keep-alive)
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws)


@app.get("/api/state")
async def get_state() -> dict:
    return snapshot()


@app.post("/api/session/toggle")
async def toggle_session() -> dict:
    if STATE["session_active"]:
        stop_session(archive=True)
    else:
        start_session()
    snap = snapshot()
    await hub.broadcast(snap)
    return snap


@app.post("/api/mock/toggle-state")
async def toggle_state(body: ToggleStateBody) -> dict:
    if not any([body.scenario, body.status, body.connection]):
        raise HTTPException(status_code=400, detail="Provide scenario, status, or connection")
    if body.scenario:
        apply_scenario(body.scenario)
    if body.connection:
        apply_connection(body.connection)
    if body.status:
        targets = [body.line_id] if body.line_id else list(LINE_IDS)
        for lid in targets:
            STATE["lines"][lid]["status"] = body.status
    snap = snapshot()
    await hub.broadcast(snap)
    return snap


@app.get("/api/sessions")
async def get_sessions() -> dict:
    ordered = sorted(SESSIONS, key=lambda s: s["started_at"], reverse=True)
    return {"sessions": ordered}


@app.put("/api/settings/{line_id}")
async def update_settings(line_id: int, body: SettingsBody) -> dict:
    if line_id not in STATE["lines"]:
        raise HTTPException(status_code=404, detail=f"Line {line_id} not found")
    if body.target is None and body.cycle_time is None and body.run_seconds is None:
        raise HTTPException(status_code=400, detail="Provide target, cycle_time, or run_seconds")
    line = STATE["lines"][line_id]
    if body.target is not None:
        line["target"] = body.target
    if body.cycle_time is not None:
        line["cycle_time"] = body.cycle_time
    if body.run_seconds is not None:
        line["run_seconds"] = body.run_seconds
        if STATE["session_seconds"] < body.run_seconds:
            STATE["session_seconds"] = body.run_seconds
    snap = snapshot()
    await hub.broadcast(snap)
    return snap


# Frontend statis disajikan dari root "/" (didaftarkan terakhir agar tidak menimpa /api & /ws)
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    host = os.getenv("OEE_HOST", "0.0.0.0")
    port = int(os.getenv("OEE_PORT", "8000"))
    print(f"OEE mock backend  ->  http://localhost:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
