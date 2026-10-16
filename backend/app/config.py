import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BASE_DIR.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"

DB_PATH = Path(os.getenv("OEE_DB_PATH", str(BASE_DIR / "oee_local.db")))
HOST = os.getenv("OEE_HOST", "0.0.0.0")
PORT = int(os.getenv("OEE_PORT", "8000"))

# Waktu tanpa data sebelum ESP32 dianggap offline (dalam detik)
LINK_TIMEOUT_SEC = float(os.getenv("OEE_LINK_TIMEOUT_SEC", "5.0"))

# Interval checkpoint berkala ke SQLite (melindungi SD card)
CHECKPOINT_INTERVAL_SEC = float(os.getenv("OEE_CHECKPOINT_SEC", "5.0"))

LINE_IDS = (1, 2)
LABEL_FMT = "%d-%m-%Y %H:%M:%S"
