"""Monitor reads for the console: the Fleet Wall and Pulse. Polled."""

from fastapi import APIRouter, HTTPException, Query

from core.monitor.pulse import summary, throughput, work
from core.monitor.wall import JUST_CLOSED_MINUTES, wall_payload
from core.routing import Auth, RouterMeta

router = APIRouter()

ROUTER_META = RouterMeta(
    prefix="/api",
    tags=["monitor"],
    auth=Auth.REQUIRED,
)

_PULSE_TABS = {"summary": summary, "throughput": throughput, "work": work}


@router.get("/fleet-wall")
async def get_fleet_wall(just_closed_minutes: int = Query(default=JUST_CLOSED_MINUTES, ge=1, le=240)):
    """Every open case as a cell, grouped by workflow, with the fleet strip."""
    return wall_payload(just_closed_minutes=just_closed_minutes)


@router.get("/pulse/{tab}")
async def get_pulse(tab: str):
    """One Pulse tab: summary, throughput, or work (paused and stuck)."""
    read = _PULSE_TABS.get(tab)
    if read is None:
        raise HTTPException(status_code=404, detail=f"No Pulse tab {tab}; one of {', '.join(sorted(_PULSE_TABS))}.")
    return read()
