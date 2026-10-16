import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional, Union
from .config import DB_PATH, LINE_IDS

SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS line_settings (
    line_id          INTEGER PRIMARY KEY,
    target_qty       INTEGER NOT NULL DEFAULT 10,
    ideal_cycle_sec  REAL    NOT NULL DEFAULT 60.0,
    planned_prod_sec INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT
);

CREATE TABLE IF NOT EXISTS production_sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_label  TEXT,
    started_at     TEXT,
    ended_at       TEXT,
    is_active      INTEGER NOT NULL DEFAULT 0,
    elapsed_sec    INTEGER DEFAULT 0,
    l1_good        INTEGER DEFAULT 0,
    l1_reject      INTEGER DEFAULT 0,
    l1_run_sec     INTEGER DEFAULT 0,
    l1_avail       REAL DEFAULT 0.0,
    l1_perf        REAL DEFAULT 0.0,
    l1_qual        REAL DEFAULT 0.0,
    l1_oee         REAL DEFAULT 0.0,
    l1_target      INTEGER DEFAULT 10,
    l1_cycle       REAL DEFAULT 60.0,
    l1_planned_sec INTEGER DEFAULT 0,
    l2_good        INTEGER DEFAULT 0,
    l2_reject      INTEGER DEFAULT 0,
    l2_run_sec     INTEGER DEFAULT 0,
    l2_avail       REAL DEFAULT 0.0,
    l2_perf        REAL DEFAULT 0.0,
    l2_qual        REAL DEFAULT 0.0,
    l2_oee         REAL DEFAULT 0.0,
    l2_target      INTEGER DEFAULT 30,
    l2_cycle       REAL DEFAULT 60.0,
    l2_planned_sec INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS state_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    line_id    INTEGER,
    state      TEXT,
    temp_c     REAL,
    timestamp  TEXT
);

CREATE INDEX IF NOT EXISTS idx_state_logs_session ON state_logs(session_id);
"""


def init_db(path: Optional[Union[str, Path]] = None) -> sqlite3.Connection:
    """Inisialisasi file SQLite dan tabel yang diperlukan."""
    target_path = Path(path) if path else DB_PATH
    if target_path != Path(":memory:"):
        target_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(
        str(target_path),
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row

    with conn:
        conn.executescript(SCHEMA_SQL)
        now_iso = datetime.now().isoformat()
        # Seed default settings jika belum ada
        conn.execute(
            """
            INSERT OR IGNORE INTO line_settings (line_id, target_qty, ideal_cycle_sec, planned_prod_sec, updated_at)
            VALUES (1, 10, 60.0, 0, ?)
            """,
            (now_iso,),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO line_settings (line_id, target_qty, ideal_cycle_sec, planned_prod_sec, updated_at)
            VALUES (2, 30, 60.0, 0, ?)
            """,
            (now_iso,),
        )

    return conn
