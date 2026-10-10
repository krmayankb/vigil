"""The run queues and lanes are named twice and must say the same thing.

Python enqueues onto a queue by name and the agent layer's workers drain queues by
name. A queue spelled differently on one side is jobs nobody ever takes: the run
reads as queued forever and nothing errors.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from core.agents.queue import LANES, RUN_QUEUE, RUN_QUEUE_HUMAN

pytestmark = pytest.mark.unit

JOB_TS = Path(__file__).resolve().parents[3] / "services" / "agent" / "contracts" / "job.ts"


def _const(name: str) -> str:
    match = re.search(rf'export const {name} = "([^"]+)"', JOB_TS.read_text())
    assert match, f"{name} not found in {JOB_TS}"
    return match.group(1)


def test_both_sides_name_the_same_queues():
    assert (RUN_QUEUE, RUN_QUEUE_HUMAN) == (_const("RUN_QUEUE"), _const("RUN_QUEUE_HUMAN"))


def test_both_sides_know_the_same_lanes():
    match = re.search(r"export const LANES = \[([^\]]*)\]", JOB_TS.read_text())
    assert match, f"LANES not found in {JOB_TS}"
    assert tuple(re.findall(r'"([^"]+)"', match.group(1))) == LANES
