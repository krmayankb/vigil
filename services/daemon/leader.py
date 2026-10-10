"""One daemon works at a time; the others wait to take over.

The daemon's loops assume they are alone: two of them would each mint a case for
the same finding before one lost the trigger claim, run every scheduled hunt and
feed poll twice, and reconcile every run twice. So a daemon holds a session-level
Postgres advisory lock on a connection of its own for as long as it works. A second
replica blocks on that lock and starts nothing but its probes. If the leader's
connection drops, Postgres releases the lock and a standby takes it; the leader,
which can no longer prove it holds it, stops so it restarts as a standby.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# Fixed and arbitrary: every daemon of one deployment contends for the same key.
LOCK_KEY = 0x76_69_67_69_6C_64_61_65  # "vigildae"


class Leadership:
    def __init__(
        self,
        connect: Callable[[], Any],
        retry_seconds: float = 5.0,
        check_seconds: float = 10.0,
    ) -> None:
        self._connect = connect
        self._retry = retry_seconds
        self._check = check_seconds
        self._connection: Optional[Any] = None

    def _try_lock(self) -> bool:
        if self._connection is None:
            self._connection = self._connect()
            # Autocommit: the lock is the session's, and an open transaction around
            # it would hold a snapshot for the life of the process.
            self._connection.autocommit = True
        cursor = self._connection.cursor()
        try:
            cursor.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_KEY,))
            return bool(cursor.fetchone()[0])
        finally:
            cursor.close()

    def _alive(self) -> bool:
        cursor = self._connection.cursor()
        try:
            cursor.execute("SELECT 1")
            cursor.fetchone()
            return True
        finally:
            cursor.close()

    def _drop(self) -> None:
        if self._connection is not None:
            try:
                self._connection.close()
            except Exception:  # noqa: BLE001 -- already gone is the case being handled
                pass
        self._connection = None

    async def acquire(self, shutdown: asyncio.Event) -> bool:
        """Wait until this daemon leads. False when it was told to stop first."""
        announced = False
        while not shutdown.is_set():
            try:
                if await asyncio.to_thread(self._try_lock):
                    logger.info("this daemon now leads; starting its loops")
                    return True
                if not announced:
                    logger.info("another daemon leads; waiting on standby")
                    announced = True
            except Exception as exc:  # noqa: BLE001 -- the database may be coming up
                logger.warning("could not ask for leadership: %s", exc)
                self._drop()
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=self._retry)
            except asyncio.TimeoutError:
                pass
        return False

    async def hold(self, shutdown: asyncio.Event) -> None:
        """While leading, check the lock's connection; stop the daemon if it is lost."""
        while not shutdown.is_set():
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=self._check)
                return
            except asyncio.TimeoutError:
                pass
            try:
                alive = await asyncio.to_thread(self._alive)
            except Exception as exc:  # noqa: BLE001
                alive = False
                logger.error("lost the leadership connection: %s", exc)
            if not alive:
                # Postgres has let go of the lock, so another daemon may already lead.
                # Working on would make two; stopping lets this one come back as standby.
                logger.critical("no longer provably the leader; stopping this daemon")
                self._drop()
                shutdown.set()
                return

    def release(self) -> None:
        self._drop()
