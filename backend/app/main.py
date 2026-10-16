import asyncio
import contextlib
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional, Union

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import FRONTEND_DIR
from .db import init_db
from .engine import Engine
from .hub import hub
from .routes import register_routes


def create_app(db_path: Optional[Union[str, Path]] = None) -> FastAPI:
    conn = init_db(db_path)
    engine = Engine(conn)

    async def ticker_loop():
        """Background loop yang berjalan setiap 1 detik untuk tick OEE & broadcast."""
        while True:
            await asyncio.sleep(1.0)
            try:
                snap = engine.tick()
                await hub.broadcast(snap)
            except Exception as exc:
                print(f"[ticker_loop] warning: {exc!r}")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine.startup()
        ticker_task = asyncio.create_task(ticker_loop())
        try:
            yield
        finally:
            ticker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await ticker_task

    app = FastAPI(
        title="OEE Monitoring HMI Backend",
        version="2.0.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Simpan engine pada state app agar dapat diakses jika diperlukan
    app.state.engine = engine
    app.state.conn = conn

    # Daftarkan seluruh rute API dan WebSocket
    register_routes(app, engine)

    # Sajikan frontend HTML/CSS/JS statis jika folder tersedia
    if FRONTEND_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

    return app


app = create_app()
