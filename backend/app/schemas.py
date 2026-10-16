from typing import Literal, Optional
from pydantic import BaseModel, Field

LineStatus = Literal["RUNNING", "STOP", "IDLE"]


class IngestLineData(BaseModel):
    state: Optional[LineStatus] = None
    emg: Optional[bool] = False
    temp_c: Optional[float] = None
    good_delta: Optional[int] = 0
    reject_delta: Optional[int] = 0
    last_mm: Optional[int] = None


class IngestPayload(BaseModel):
    ts_ms: Optional[int] = None
    esp32_connected: Optional[bool] = True
    line1: Optional[IngestLineData] = None
    line2: Optional[IngestLineData] = None


class SettingsUpdate(BaseModel):
    target: Optional[int] = Field(None, ge=1, le=9999)
    cycle_time: Optional[float] = Field(None, ge=0.1, le=9999.0)
    planned_seconds: Optional[int] = Field(None, ge=0, le=864000)


class RecoveryAction(BaseModel):
    action: Literal["resume", "end"]
