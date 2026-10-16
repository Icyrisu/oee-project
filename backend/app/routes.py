from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from .hub import hub
from .network import get_network_info
from .repository import delete_session, get_all_sessions
from .schemas import IngestPayload, RecoveryAction, SettingsUpdate

def register_routes(app, engine):
    router = APIRouter()

    @router.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "is_online": engine.is_online,
            "session_active": engine.session_active,
        }

    @router.get("/api/network")
    async def get_network():
        return get_network_info()

    @router.get("/api/state")
    async def get_state():
        return engine.snapshot()

    @router.post("/api/ingest")
    async def ingest_packet(payload: IngestPayload):
        engine.ingest(payload)
        return {"status": "ok"}

    @router.post("/api/session/toggle")
    async def toggle_session():
        try:
            snap = engine.toggle_session()
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err))
        await hub.broadcast(snap)
        return snap

    @router.post("/api/session/recovery")
    async def session_recovery(body: RecoveryAction):
        snap = engine.handle_recovery(body.action)
        await hub.broadcast(snap)
        return snap

    @router.get("/api/sessions")
    async def get_sessions():
        sessions = get_all_sessions(engine.conn)
        return {"sessions": sessions}

    @router.delete("/api/sessions/{session_id}")
    async def remove_session(session_id: int):
        if engine.session_active and engine.session_id == session_id:
            raise HTTPException(status_code=400, detail="Cannot delete currently active session")
        ok = delete_session(engine.conn, session_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Session not found")
        return {"status": "ok", "deleted_id": session_id}

    @router.put("/api/settings/{line_id}")
    async def update_settings(line_id: int, body: SettingsUpdate):
        if line_id not in (1, 2):
            raise HTTPException(status_code=404, detail=f"Line {line_id} not found")
        if body.target is None and body.cycle_time is None and body.planned_seconds is None:
            raise HTTPException(status_code=400, detail="Provide at least one of target, cycle_time, or planned_seconds")

        try:
            snap = engine.update_line_setting(line_id, body)
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err))
        await hub.broadcast(snap)
        return snap

    @router.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket):
        await hub.connect(ws)
        try:
            await ws.send_json(engine.snapshot())
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            hub.disconnect(ws)

    @router.post("/api/system/poweroff")
    async def system_poweroff():
        import os
        import sys
        import threading
        import time

        if engine.session_active:
            engine._save_checkpoint()

        def _do_shutdown():
            time.sleep(0.8)
            if sys.platform.startswith("linux"):
                os.system("sudo poweroff")
            else:
                print("[SYSTEM] Simulated poweroff triggered")

        threading.Thread(target=_do_shutdown, daemon=True).start()
        return {"status": "ok", "message": "System is powering off"}

    app.include_router(router)
