"""A workflow run's job carries its workflow as the budget scope, and its caps if any."""

from unittest.mock import MagicMock, patch

import pytest

from core.triage.budgets import budget_for

pytestmark = pytest.mark.unit


def _with(row):
    service = MagicMock()
    service.get_system_config.return_value = row
    return patch("core.triage.budgets.get_config_service", return_value=service)


def test_every_run_names_its_workflow_so_its_cost_is_learned():
    with _with(None):
        assert budget_for("full-investigation") == {"scope": "full-investigation"}


def test_a_workflow_with_caps_carries_them():
    with _with({"full-investigation": {"hourly_usd": 20, "daily_usd": "200"}}):
        assert budget_for("full-investigation") == {"scope": "full-investigation", "hourly_usd": 20.0, "daily_usd": 200.0}


def test_a_cap_that_is_not_a_positive_number_is_no_cap():
    with _with({"full-investigation": {"hourly_usd": 0, "daily_usd": "lots"}}):
        assert budget_for("full-investigation") == {"scope": "full-investigation"}


def test_an_unreadable_row_still_names_the_scope():
    with patch("core.triage.budgets.get_config_service", side_effect=RuntimeError("db down")):
        assert budget_for("x") == {"scope": "x"}
