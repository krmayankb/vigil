"""Overlap at intake skips busy entities.

A finding merges into open work that shares an entity with it, but an entity that
is everywhere -- a domain controller, a NAT gateway -- says nothing about whether
two findings are the same work. One already in the threshold's worth of live
investigations stops counting, and so does one an operator listed.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from services.daemon import shared_intel
from services.daemon.shared_intel import SharedIntelligence

pytestmark = pytest.mark.unit


class _Repo:
    def __init__(self, live: dict[str, set[str]]):
        self.live = live

    def open_investigations_for(self, keys):
        (key,) = list(keys)
        return set(self.live.get(key, set()))


def _check(live, keys, threshold=3, ignore="", exclude=None):
    intel = object.__new__(SharedIntelligence)
    intel._with_repo = lambda _op, fn, _default: fn(_Repo(live))
    settings = SimpleNamespace(triage_busy_entity_threshold=threshold, triage_overlap_ignore=ignore)
    with patch.object(shared_intel, "_keys_from_finding", return_value=set(keys)), patch.object(
        shared_intel, "get_settings", return_value=settings
    ):
        return intel.check_overlap({"finding_id": "f"}, exclude_id=exclude)


def test_a_quiet_shared_entity_still_merges():
    assert _check({"hostname:ws-17": {"inv-a"}}, ["hostname:ws-17"]) == ["inv-a"]


def test_a_busy_entity_alone_does_not_merge():
    busy = {"hostname:dc01": {"inv-a", "inv-b", "inv-c"}}
    assert _check(busy, ["hostname:dc01"]) == []


def test_a_busy_entity_does_not_hide_a_quiet_one_beside_it():
    live = {"hostname:dc01": {"inv-a", "inv-b", "inv-c"}, "user:j.ortiz": {"inv-d"}}
    assert _check(live, ["hostname:dc01", "user:j.ortiz"]) == ["inv-d"]


def test_an_entity_the_operator_listed_never_merges():
    assert _check({"ip:10.0.0.1": {"inv-a"}}, ["ip:10.0.0.1"], ignore=" IP:10.0.0.1 , hostname:x") == []


def test_a_threshold_of_zero_skips_nothing():
    busy = {"hostname:dc01": {"inv-a", "inv-b", "inv-c", "inv-d"}}
    assert _check(busy, ["hostname:dc01"], threshold=0) == ["inv-a", "inv-b", "inv-c", "inv-d"]


def test_the_investigation_asking_is_not_counted_toward_its_own_entity():
    live = {"hostname:ws-17": {"inv-self", "inv-a", "inv-b"}}
    assert _check(live, ["hostname:ws-17"], exclude="inv-self") == ["inv-a", "inv-b"]
