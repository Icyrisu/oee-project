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


def test_api_session_lifecycle(client):
    # Start session
    res_start = client.post("/api/session/toggle")
    assert res_start.status_code == 200
    assert res_start.json()["session_active"] is True

    # Stop session
    res_stop = client.post("/api/session/toggle")
    assert res_stop.status_code == 200
    assert res_stop.json()["session_active"] is False

    # Check sessions list
    res_sessions = client.get("/api/sessions")
    assert res_sessions.status_code == 200
    assert "sessions" in res_sessions.json()
    assert len(res_sessions.json()["sessions"]) == 1
