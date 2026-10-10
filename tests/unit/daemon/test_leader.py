"""One daemon leads; a second waits on standby and takes over if the leader goes."""

from __future__ import annotations

import asyncio

import pytest

from services.daemon.leader import LOCK_KEY, Leadership

pytestmark = pytest.mark.unit


class _Lock:
    """One advisory lock shared by every fake connection, as Postgres holds one."""

    def __init__(self):
        self.holder = None


class _Connection:
    def __init__(self, lock: _Lock):
        self.lock = lock
        self.autocommit = False
        self.closed = False
        self.dead = False

    def cursor(self):
        return _Cursor(self)

    def close(self):
        self.closed = True
        if self.lock.holder is self:
            self.lock.holder = None


class _Cursor:
    def __init__(self, connection: _Connection):
        self.connection = connection
        self.result = None

    def execute(self, sql, params=None):
        if self.connection.dead:
            raise OSError("server closed the connection unexpectedly")
        if "pg_try_advisory_lock" in sql:
            assert params == (LOCK_KEY,)
            lock = self.connection.lock
            if lock.holder in (None, self.connection):
                lock.holder = self.connection
                self.result = (True,)
            else:
                self.result = (False,)
        else:
            self.result = (1,)

    def fetchone(self):
        return self.result

    def close(self):
        pass


async def test_the_first_daemon_leads_and_the_second_waits():
    lock = _Lock()
    first = Leadership(lambda: _Connection(lock), retry_seconds=0.01)
    second = Leadership(lambda: _Connection(lock), retry_seconds=0.01)
    stop = asyncio.Event()

    assert await first.acquire(stop)
    waiting = asyncio.create_task(second.acquire(stop))
    await asyncio.sleep(0.05)
    assert not waiting.done()

    # The leader goes: Postgres lets go of its lock, and the standby takes it.
    first.release()
    assert await asyncio.wait_for(waiting, timeout=1)


async def test_a_standby_told_to_stop_never_leads():
    lock = _Lock()
    leader = Leadership(lambda: _Connection(lock), retry_seconds=0.01)
    standby = Leadership(lambda: _Connection(lock), retry_seconds=0.01)
    stop = asyncio.Event()
    assert await leader.acquire(stop)
    waiting = asyncio.create_task(standby.acquire(stop))
    stop.set()
    assert await asyncio.wait_for(waiting, timeout=1) is False


async def test_a_leader_that_loses_its_connection_stops_the_daemon():
    lock = _Lock()
    connections = []

    def connect():
        connections.append(_Connection(lock))
        return connections[-1]

    leader = Leadership(connect, retry_seconds=0.01, check_seconds=0.01)
    stop = asyncio.Event()
    assert await leader.acquire(stop)
    connections[0].dead = True
    await asyncio.wait_for(leader.hold(stop), timeout=1)
    assert stop.is_set()


async def test_a_database_that_is_not_up_yet_is_asked_again():
    lock = _Lock()
    attempts = []

    def connect():
        attempts.append(1)
        if len(attempts) < 3:
            raise OSError("connection refused")
        return _Connection(lock)

    leader = Leadership(connect, retry_seconds=0.01)
    assert await asyncio.wait_for(leader.acquire(asyncio.Event()), timeout=1)
    assert len(attempts) == 3
