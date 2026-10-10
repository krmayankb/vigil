"""What a triage item is: an activity class, a confidence, and the reason.

A classifier is anything with a ``name`` and a ``classify(item)``. ``RulesV1`` is
the five rules the daemon has always routed findings by, recast as classes so the
route table, not the rules, decides where each goes. A model-backed classifier
can replace it without the daemon or the route table changing.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, Protocol


@dataclass(frozen=True)
class Classification:
    activity_class: str
    # 0..1. A rule that matched is certain of what it matched; a model is not.
    confidence: float
    reason: str
    classifier: str

    def to_record(self) -> Dict[str, Any]:
        return asdict(self)


class Classifier(Protocol):
    name: str

    def classify(self, item: Dict[str, Any]) -> Classification: ...


# The classes RulesV1 can answer, in the order its rules are tried.
CONTAINMENT_ASKED = "containment-asked"
CRITICAL = "critical"
MALWARE = "malware"
MULTI_TECHNIQUE = "multi-technique"
HIGH_SEVERITY = "high-severity"
UNCLASSIFIED = "unclassified"
# Items a person or a schedule raised, which carry their workflow with them.
HUMAN_ASK = "human-ask"
SCHEDULED = "scheduled"


class RulesV1:
    """The rules select_workflow applied, first match wins."""

    name = "rules-v1"

    def classify(self, item: Dict[str, Any]) -> Classification:
        severity = (item.get("severity") or "").lower()
        recommended = (item.get("recommended_action") or "").lower()
        category = (item.get("category") or "").lower()
        techniques = item.get("mitre_predictions") or {}

        def found(activity: str, reason: str) -> Classification:
            return Classification(activity, 1.0, reason, self.name)

        if recommended in ("isolate", "block"):
            return found(CONTAINMENT_ASKED, f"detection recommends {recommended}")
        if severity == "critical":
            return found(CRITICAL, "critical severity")
        if category in ("malware", "ransomware"):
            return found(MALWARE, f"{category} category")
        if len(techniques) >= 3:
            return found(MULTI_TECHNIQUE, f"{len(techniques)} ATT&CK techniques predicted")
        if severity == "high":
            return found(HIGH_SEVERITY, "high severity")
        return found(UNCLASSIFIED, "no rule matched")


DEFAULT_CLASSIFIER: Classifier = RulesV1()
