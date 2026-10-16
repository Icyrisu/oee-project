import sys
from pathlib import Path

# Pastikan root proyek berada dalam sys.path
PROJECT_DIR = Path(__file__).resolve().parent.parent
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

import uvicorn
from backend.app.config import HOST, PORT

if __name__ == "__main__":
    print(f"OEE Production Backend -> http://{HOST}:{PORT}")
    uvicorn.run("backend.app.main:app", host=HOST, port=PORT, reload=False)
