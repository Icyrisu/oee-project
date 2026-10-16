import pytest
from fastapi.testclient import TestClient
from backend.app.main import create_app


@pytest.fixture
def client():
    # Use in-memory SQLite database for isolated testing
    app = create_app(":memory:")
    with TestClient(app) as c:
        yield c


def test_api_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["session_active"] is False


def test_api_state(client):
    res = client.get("/api/state")
    assert res.status_code == 200
    data = res.json()
    assert data["type"] == "state"
    assert "lines" in data
    assert len(data["lines"]) == 2


def test_api_ingest(client):
    payload = {
        "ts_ms": 123456,
        "esp32_connected": True,
        "line1": {
            "state": "RUNNING",
            "emg": False,
            "temp_c": 31.5,
            "good_delta": 2,
            "reject_delta": 0,
        },
        "line2": {
            "state": "STOP",
            "emg": False,
            "temp_c": 30.1,
            "good_delta": 0,
            "reject_delta": 0,
        },
    }
    res = client.post("/api/ingest", json=payload)
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}

    # Verify state reflects ingest
    res_state = client.get("/api/state")
    data = res_state.json()
    assert data["is_online"] is True
    assert data["lines"][0]["temp_c"] == 31.5


def test_api_settings_update(client):
    # Setting update succeeds when session is inactive
    res = client.put(
        "/api/settings/1",
        json={"target": 50, "cycle_time": 45.0, "planned_seconds": 3600},
    )
    assert res.status_code == 200
    data = res.json()
    line1 = next(l for l in data["lines"] if l["id"] == 1)
    assert line1["target"] == 50
    assert line1["cycle_time"] == 45.0
    assert line1["planned_seconds"] == 3600

    # Start session
    client.post("/api/ingest", json={"ts_ms": 1000, "esp32_connected": True})
    res_start = client.post("/api/session/toggle")
    assert res_start.status_code == 200
    assert res_start.json()["session_active"] is True

    # Try to update settings while session is active -> HTTP 400
    res_locked = client.put("/api/settings/1", json={"target": 100})
    assert res_locked.status_code == 400
    assert "locked" in res_locked.json()["detail"].lower()



def test_api_session_lifecycle(client):
    # 1. Starting session while offline must return HTTP 400
    res_offline = client.post("/api/session/toggle")
    assert res_offline.status_code == 400
    assert "offline" in res_offline.json()["detail"].lower()

    # 2. Make machine online via ingest
    client.post("/api/ingest", json={"ts_ms": 1000, "esp32_connected": True})

    # 3. Start session while online succeeds
    res_start = client.post("/api/session/toggle")
    assert res_start.status_code == 200
    assert res_start.json()["session_active"] is True

    # 4. Stop session
    res_stop = client.post("/api/session/toggle")
    assert res_stop.status_code == 200
    assert res_stop.json()["session_active"] is False

    # 5. Check sessions list
    res_sessions = client.get("/api/sessions")
    assert res_sessions.status_code == 200
    sessions = res_sessions.json()["sessions"]
    assert len(sessions) == 1
    session_id = sessions[0]["id"]

    # 6. Delete session
    res_del = client.delete(f"/api/sessions/{session_id}")
    assert res_del.status_code == 200
    assert res_del.json()["status"] == "ok"

    # 7. Check sessions list is now empty
    res_sessions_after = client.get("/api/sessions")
    assert len(res_sessions_after.json()["sessions"]) == 0


def test_api_network(client):
    res = client.get("/api/network")
    assert res.status_code == 200
    data = res.json()
    assert "hotspot_ip" in data
    assert "hostname" in data
    assert "lan_ip" in data

