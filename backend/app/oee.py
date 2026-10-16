"""Modul perhitungan metrik OEE (Availability, Performance, Quality)."""

from typing import Dict


def compute_metrics(
    good: int,
    reject: int,
    run_seconds: int,
    cycle_time: float,
    planned_seconds: int,
    elapsed_seconds: int,
) -> Dict[str, float]:
    """Menghitung Availability, Performance, Quality, dan OEE dalam persen (0.0 - 100.0).

    Aturan:
    - Base Availability: jika planned_seconds > 0 gunakan planned_seconds;
      jika planned_seconds == 0 gunakan elapsed_seconds (waktu sesi berjalan).
    - Jika base == 0 atau run_seconds == 0, metrik terkait adalah 0.0.
    - Performance dan Availability dibatasi maksimal 100%.
    """
    total = max(0, int(good)) + max(0, int(reject))
    run = max(0, int(run_seconds))
    cycle = max(0.0, float(cycle_time))
    planned = max(0, int(planned_seconds))
    elapsed = max(0, int(elapsed_seconds))

    base_avail = planned if planned > 0 else elapsed
    availability = min(1.0, run / base_avail) if base_avail > 0 else 0.0
    performance = min(1.0, (cycle * total) / run) if run > 0 else 0.0
    quality = (good / total) if total > 0 else 0.0
    oee = availability * performance * quality

    return {
        "availability": round(availability * 100.0, 1),
        "performance": round(performance * 100.0, 1),
        "quality": round(quality * 100.0, 1),
        "oee": round(oee * 100.0, 1),
    }
