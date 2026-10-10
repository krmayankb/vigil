"""Work a person is waiting on goes to its own queue; automated work waits in order.

The agent layer drains agent-runs-human with worker slots kept for it, so a backlog
of automated runs never stands between a person and an answer. Automated runs are
ordered by severity; a person's are taken as they come.
"""

from unittest.mock import AsyncMock, patch

import pytest

from core.agents import queue as run_queue
from core.agents.queue import (
    RUN_QUEUE,
    RUN_QUEUE_HUMAN,
    build_resume_job,
    build_start_job,
    enqueue_run,
    priority_for,
)

pytestmark = pytest.mark.unit


class _Queue:
    def __init__(self, name, _options):
        self.name = name
        self.added = []

    async def add(self, name, job, options):
        self.added.append((name, job, options))
        return type("Job", (), {"id": options["jobId"]})()

    async def close(self):
        pass


@pytest.fixture
def queues():
    made = {}

    def factory(name, options):
        made[name] = made.get(name) or _Queue(name, options)
        return made[name]

    with patch.object(run_queue, "Queue", side_effect=factory):
        yield made


async def test_a_persons_run_goes_to_the_human_queue_without_a_priority(queues):
    job = build_start_job("r-1", "investigate", {}, enqueued_by="alice", lane="human")
    await enqueue_run(job, priority=1)
    await run_queue.close_run_queue()

    (_, sent, options), = queues[RUN_QUEUE_HUMAN].added
    assert sent["lane"] == "human"
    assert "priority" not in options
    assert RUN_QUEUE not in queues


async def test_an_automated_run_waits_in_severity_order(queues):
    job = build_start_job("r-2", "investigate", {}, enqueued_by="orchestrator")
    await enqueue_run(job, priority=priority_for("high"))
    await run_queue.close_run_queue()

    (_, sent, options), = queues[RUN_QUEUE].added
    assert sent["lane"] == "automated"
    assert options["priority"] == 2


def test_the_most_severe_runs_first_and_anything_unrated_last():
    order = [priority_for(band) for band in ("critical", "high", "medium", "low", None, "bogus")]
    assert order == sorted(order)
    assert priority_for("Critical ") == 1
    assert priority_for(None) == priority_for("unknown") == 5


def test_a_lane_that_is_neither_is_refused():
    with pytest.raises(ValueError, match="lane must be one of"):
        build_start_job("r-3", "investigate", {}, enqueued_by="x", lane="urgent")
    with pytest.raises(ValueError, match="lane must be one of"):
        build_resume_job("r-3", "investigate", enqueued_by="x", lane="")


def test_a_resume_is_automated_unless_a_person_is_waiting():
    assert build_resume_job("r-4", "hunt", enqueued_by="watchdog")["lane"] == "automated"
    assert build_resume_job("r-4", "hunt", enqueued_by="bob", lane="human")["lane"] == "human"
