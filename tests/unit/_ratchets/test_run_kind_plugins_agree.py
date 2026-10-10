"""Which plugin each run kind runs on is written twice and must say the same thing.

Triage records the plugin on its decision and the job carries it; the agent layer
refuses a job whose plugin is not the one its kind runs. A plugin spelled
differently on one side is every run of that kind refused before it starts.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from core.triage.routes import RUN_KIND_PLUGINS

pytestmark = pytest.mark.unit

KINDS_TS = Path(__file__).resolve().parents[3] / "services" / "agent" / "plugins" / "kinds.ts"


def test_both_sides_map_each_run_kind_to_the_same_plugin():
    text = KINDS_TS.read_text()
    match = re.search(r"export const KIND_PLUGINS[^=]*=\s*\{([^}]*)\}", text)
    assert match, f"KIND_PLUGINS not found in {KINDS_TS}"
    typescript = dict(re.findall(r'(\w+):\s*"([^"]+)"', match.group(1)))
    assert typescript == dict(RUN_KIND_PLUGINS)


def test_every_mapped_plugin_has_a_manifest():
    plugins = KINDS_TS.parent
    for kind, plugin in RUN_KIND_PLUGINS.items():
        assert (plugins / plugin / "plugin.yaml").is_file(), f"{kind} maps to {plugin}, which has no plugin.yaml"
