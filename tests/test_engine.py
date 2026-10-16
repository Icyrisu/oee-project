import sqlite3
import time
from backend.app.db import init_db
from backend.app.engine import Engine
from backend.app.schemas import IngestLineData, IngestPayload, SettingsUpdate


def test_engine_initial_state():
    conn = init_db(":memory:")
    engine = Engine(conn)
    engine.startup()

    snap = engine.snapshot()
    assert snap["session_active"] is False
    assert snap["is_online"] is False
    assert snap["recovery_pending"] is False
    assert len(snap["lines"]) == 2
    assert snap["lines"][0]["target"] == 10
    assert snap["lines"][1]["target"] == 30


def test_engine_ingest_and_session_lifecycle():
    conn = init_db(":memory:")
    engine = Engine(conn)
    engine.startup()

    # 1. Ingest packet while session is not started -> machine stays IDLE
    payload = IngestPayload(
        ts_ms=1000,
        esp32_connected=True,
        line1=IngestLineData(state="RUNNING", temp_c=31.2, good_delta=1),
        line2=IngestLineData(state="IDLE", temp_c=29.8),
    )
    engine.ingest(payload)
    snap = engine.snapshot()
    assert snap["is_online"] is True
    # Session not started yet, so good_delta is not counted and status is IDLE
    assert snap["lines"][0]["status"] == "IDLE"
    assert snap["lines"][0]["good"] == 0

    # 2. Operator starts session on web
    engine.start_session()
    snap = engine.snapshot()
    assert snap["session_active"] is True
    assert snap["session_seconds"] == 0

    # 3. Hardware reports line 1 is RUNNING (operator pressed PB1)
    engine.ingest(
        IngestPayload(
            ts_ms=2000,
            esp32_connected=True,
            line1=IngestLineData(state="RUNNING", temp_c=31.5, good_delta=5, reject_delta=1),
        )
    )
    assert engine.lines[1]["status"] == "RUNNING"
    assert engine.lines[1]["good"] == 5
    assert engine.lines[1]["reject"] == 1

    # 4. Tick 10 times -> elapsed increments by 10, line1 run_seconds increments by 10
    for _ in range(10):
        engine.tick()

    snap = engine.snapshot()
    assert snap["session_seconds"] == 10
    assert snap["lines"][0]["run_seconds"] == 10

    # 5. Stop session -> archives to SQLite
    engine.stop_session()
    snap = engine.snapshot()
    assert snap["session_active"] is False

    cur = conn.cursor()
    cur.execute("SELECT * FROM production_sessions WHERE is_active = 0")
    rows = cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["l1_good"] == 5
    assert rows[0]["l1_reject"] == 1
    assert rows[0]["l1_run_sec"] == 10


def test_engine_start_session_offline_rejected():
    import pytest
    conn = init_db(":memory:")
    engine = Engine(conn)
    engine.startup()
    assert engine.is_online is False
    with pytest.raises(ValueError, match="Cannot start session while machine is offline"):
        engine.start_session()


def test_engine_emergency_stop():
    conn = init_db(":memory:")
    engine = Engine(conn)
    engine.startup()
    engine.is_online = True
    engine.start_session()

    # Hardware sends EMG = True
    engine.ingest(
        IngestPayload(
            ts_ms=3000,
            esp32_connected=True,
            line1=IngestLineData(state="RUNNING", emg=True, temp_c=30.0),
        )
    )
    assert engine.lines[1]["status"] == "STOP"
    assert engine.lines[1]["emg"] is True


def test_engine_interrupted_session_recovery():
    conn = init_db(":memory:")
    engine1 = Engine(conn)
    engine1.startup()
    engine1.is_online = True
    engine1.start_session()

    engine1.ingest(
        IngestPayload(
            ts_ms=1000,
            esp32_connected=True,
            line1=IngestLineData(state="RUNNING", good_delta=8, reject_delta=2),
        )
    )
    for _ in range(5):
        engine1.tick()  # Triggers checkpoint at 5 seconds

    # Simulate sudden power loss without calling stop_session
    # When new Engine starts on the same DB:
    engine2 = Engine(conn)
    engine2.startup()

    snap = engine2.snapshot()
    assert snap["recovery_pending"] is True
    assert snap["recovery_session"]["l1_good"] == 8
    assert snap["recovery_session"]["l1_reject"] == 2

    # Operator decides to "resume"
    engine2.handle_recovery("resume")
    snap2 = engine2.snapshot()
    assert snap2["recovery_pending"] is False
    assert snap2["session_active"] is True
    assert snap2["lines"][0]["good"] == 8
    assert snap2["lines"][0]["reject"] == 2


def test_engine_update_setting_during_active_session_rejected():
    import pytest
    conn = init_db(":memory:")
    engine = Engine(conn)
    engine.startup()
    engine.is_online = True

    # 1. Setting update succeeds when session is inactive
    engine.update_line_setting(1, SettingsUpdate(target=50))
    assert engine.lines[1]["target"] == 50

    # 2. Start session
    engine.start_session()
    assert engine.session_active is True

    # 3. Setting update is rejected with ValueError
    with pytest.raises(ValueError, match="Settings are locked during an active production session"):
        engine.update_line_setting(1, SettingsUpdate(target=100))

    # Target unchanged
    assert engine.lines[1]["target"] == 50

    # 4. Stop session
    engine.stop_session()
    assert engine.session_active is False

    # 5. Setting update succeeds again
    engine.update_line_setting(1, SettingsUpdate(target=100))
    assert engine.lines[1]["target"] == 100

