import pytest
from backend.app.oee import compute_metrics


def test_oee_zeros():
    res = compute_metrics(
        good=0,
        reject=0,
        run_seconds=0,
        cycle_time=60,
        planned_seconds=0,
        elapsed_seconds=0,
    )
    assert res == {
        "availability": 0.0,
        "performance": 0.0,
        "quality": 0.0,
        "oee": 0.0,
    }


def test_availability_uses_planned_seconds_when_set():
    # run 3600s, planned 7200s -> Avail = 50%
    res = compute_metrics(
        good=50,
        reject=10,
        run_seconds=3600,
        cycle_time=60,
        planned_seconds=7200,
        elapsed_seconds=4000,
    )
    assert res["availability"] == 50.0
    # Quality: 50 / 60 = 83.3%
    assert res["quality"] == 83.3
    # Performance: (60 * 60) / 3600 = 1.0 -> 100%
    assert res["performance"] == 100.0
    # OEE: 0.5 * 1.0 * (5/6) = 0.41666 -> 41.7%
    assert res["oee"] == 41.7


def test_availability_falls_back_to_elapsed_when_planned_zero():
    # User comment: "iya jika diisi 0 maka akan pakai sesi berjalan karena akan ada keadaan stop jadi itu nanti akan terbaca sebagai downtime"
    # elapsed 3600s, run 1800s (downtime 1800s) -> Avail = 1800 / 3600 = 50.0%
    res = compute_metrics(
        good=20,
        reject=0,
        run_seconds=1800,
        cycle_time=60,
        planned_seconds=0,
        elapsed_seconds=3600,
    )
    assert res["availability"] == 50.0
    assert res["quality"] == 100.0


def test_metrics_capped_at_100():
    # If run > planned or total > expected cycle
    res = compute_metrics(
        good=100,
        reject=0,
        run_seconds=5000,
        cycle_time=60,
        planned_seconds=3600,
        elapsed_seconds=5000,
    )
    assert res["availability"] == 100.0
    assert res["performance"] == 100.0
    assert res["quality"] == 100.0
    assert res["oee"] == 100.0
