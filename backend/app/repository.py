import sqlite3
from datetime import datetime
from typing import Dict, List, Optional


def get_all_settings(conn: sqlite3.Connection) -> Dict[int, dict]:
    """Mengambil semua pengaturan line produksi dari database."""
    cur = conn.cursor()
    cur.execute("SELECT line_id, target_qty, ideal_cycle_sec, planned_prod_sec FROM line_settings")
    rows = cur.fetchall()
    res = {}
    for r in rows:
        res[r["line_id"]] = {
            "target": r["target_qty"],
            "cycle_time": r["ideal_cycle_sec"],
            "planned_seconds": r["planned_prod_sec"],
        }
    return res


def update_setting(
    conn: sqlite3.Connection,
    line_id: int,
    target: Optional[int] = None,
    cycle_time: Optional[float] = None,
    planned_seconds: Optional[int] = None,
) -> dict:
    """Memperbarui pengaturan line."""
    cur = conn.cursor()
    cur.execute("SELECT target_qty, ideal_cycle_sec, planned_prod_sec FROM line_settings WHERE line_id = ?", (line_id,))
    row = cur.fetchone()
    if not row:
        raise ValueError(f"Line {line_id} tidak ditemukan")

    new_target = target if target is not None else row["target_qty"]
    new_cycle = cycle_time if cycle_time is not None else row["ideal_cycle_sec"]
    new_planned = planned_seconds if planned_seconds is not None else row["planned_prod_sec"]
    now_iso = datetime.now().isoformat()

    with conn:
        conn.execute(
            """
            UPDATE line_settings
            SET target_qty = ?, ideal_cycle_sec = ?, planned_prod_sec = ?, updated_at = ?
            WHERE line_id = ?
            """,
            (new_target, new_cycle, new_planned, now_iso, line_id),
        )

    return {
        "line_id": line_id,
        "target": new_target,
        "cycle_time": new_cycle,
        "planned_seconds": new_planned,
    }


def create_session(
    conn: sqlite3.Connection,
    label: str,
    started_at: str,
    l1_settings: dict,
    l2_settings: dict,
) -> int:
    """Membuat sesi baru berstatus aktif di database."""
    with conn:
        cur = conn.execute(
            """
            INSERT INTO production_sessions (
                session_label, started_at, is_active, elapsed_sec,
                l1_target, l1_cycle, l1_planned_sec,
                l2_target, l2_cycle, l2_planned_sec
            )
            VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?)
            """,
            (
                label,
                started_at,
                l1_settings.get("target", 10),
                l1_settings.get("cycle_time", 60.0),
                l1_settings.get("planned_seconds", 0),
                l2_settings.get("target", 30),
                l2_settings.get("cycle_time", 60.0),
                l2_settings.get("planned_seconds", 0),
            ),
        )
        return int(cur.lastrowid)


def checkpoint_session(
    conn: sqlite3.Connection,
    session_id: int,
    elapsed_sec: int,
    l1: dict,
    l2: dict,
    l1_m: dict,
    l2_m: dict,
) -> None:
    """Menyimpan checkpoint data sesi yang sedang aktif ke SQLite."""
    with conn:
        conn.execute(
            """
            UPDATE production_sessions
            SET elapsed_sec = ?,
                l1_good = ?, l1_reject = ?, l1_run_sec = ?,
                l1_avail = ?, l1_perf = ?, l1_qual = ?, l1_oee = ?,
                l2_good = ?, l2_reject = ?, l2_run_sec = ?,
                l2_avail = ?, l2_perf = ?, l2_qual = ?, l2_oee = ?
            WHERE id = ?
            """,
            (
                elapsed_sec,
                l1.get("good", 0),
                l1.get("reject", 0),
                l1.get("run_seconds", 0),
                l1_m.get("availability", 0.0),
                l1_m.get("performance", 0.0),
                l1_m.get("quality", 0.0),
                l1_m.get("oee", 0.0),
                l2.get("good", 0),
                l2.get("reject", 0),
                l2.get("run_seconds", 0),
                l2_m.get("availability", 0.0),
                l2_m.get("performance", 0.0),
                l2_m.get("quality", 0.0),
                l2_m.get("oee", 0.0),
                session_id,
            ),
        )


def finish_session(
    conn: sqlite3.Connection,
    session_id: int,
    ended_at: str,
    elapsed_sec: int,
    l1: dict,
    l2: dict,
    l1_m: dict,
    l2_m: dict,
) -> None:
    """Mengakhiri sesi dan menandai is_active = 0."""
    with conn:
        conn.execute(
            """
            UPDATE production_sessions
            SET is_active = 0,
                ended_at = ?,
                elapsed_sec = ?,
                l1_good = ?, l1_reject = ?, l1_run_sec = ?,
                l1_avail = ?, l1_perf = ?, l1_qual = ?, l1_oee = ?,
                l2_good = ?, l2_reject = ?, l2_run_sec = ?,
                l2_avail = ?, l2_perf = ?, l2_qual = ?, l2_oee = ?
            WHERE id = ?
            """,
            (
                ended_at,
                elapsed_sec,
                l1.get("good", 0),
                l1.get("reject", 0),
                l1.get("run_seconds", 0),
                l1_m.get("availability", 0.0),
                l1_m.get("performance", 0.0),
                l1_m.get("quality", 0.0),
                l1_m.get("oee", 0.0),
                l2.get("good", 0),
                l2.get("reject", 0),
                l2.get("run_seconds", 0),
                l2_m.get("availability", 0.0),
                l2_m.get("performance", 0.0),
                l2_m.get("quality", 0.0),
                l2_m.get("oee", 0.0),
                session_id,
            ),
        )


def get_active_session(conn: sqlite3.Connection) -> Optional[dict]:
    """Mencari sesi yang masih aktif (misal saat restart setelah mati listrik)."""
    cur = conn.cursor()
    cur.execute("SELECT * FROM production_sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    if not row:
        return None
    return dict(row)


def get_all_sessions(conn: sqlite3.Connection, limit: int = 100) -> List[dict]:
    """Mengambil daftar riwayat sesi untuk tampilan Report."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT * FROM production_sessions
        ORDER BY started_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    rows = cur.fetchall()
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "label": r["session_label"] or f"Session #{r['id']}",
            "started_at": r["started_at"],
            "ended_at": r["ended_at"],
            "duration_seconds": r["elapsed_sec"] or 0,
            "is_active": bool(r["is_active"]),
            "lines": [
                {
                    "id": 1,
                    "good": r["l1_good"] or 0,
                    "reject": r["l1_reject"] or 0,
                    "run_seconds": r["l1_run_sec"] or 0,
                    "availability": r["l1_avail"] or 0.0,
                    "performance": r["l1_perf"] or 0.0,
                    "quality": r["l1_qual"] or 0.0,
                    "oee": r["l1_oee"] or 0.0,
                    "target": r["l1_target"],
                    "cycle_time": r["l1_cycle"],
                    "planned_seconds": r["l1_planned_sec"],
                },
                {
                    "id": 2,
                    "good": r["l2_good"] or 0,
                    "reject": r["l2_reject"] or 0,
                    "run_seconds": r["l2_run_sec"] or 0,
                    "availability": r["l2_avail"] or 0.0,
                    "performance": r["l2_perf"] or 0.0,
                    "quality": r["l2_qual"] or 0.0,
                    "oee": r["l2_oee"] or 0.0,
                    "target": r["l2_target"],
                    "cycle_time": r["l2_cycle"],
                    "planned_seconds": r["l2_planned_sec"],
                },
            ],
        })
    return result


def log_state_change(
    conn: sqlite3.Connection,
    session_id: Optional[int],
    line_id: int,
    state: str,
    temp_c: float,
    timestamp: str,
) -> None:
    """Mencatat perubahan status line ke tabel state_logs."""
    with conn:
        conn.execute(
            """
            INSERT INTO state_logs (session_id, line_id, state, temp_c, timestamp)
            VALUES (?, ?, ?, ?, ?)
            """,
            (session_id, line_id, state, temp_c, timestamp),
        )
