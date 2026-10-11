"""Remove the demo fleet that scripts/demo_monitor_seed.py wrote (every row tagged demo-)."""
from core.storage.connection import get_db_manager
from core.storage.models import ApprovalAction, Case, CaseClosureInfo, Finding, IntakeTrigger, WorkflowRun, case_findings
from core.storage.unit_of_work import unit_of_work

get_db_manager().initialize()
with unit_of_work() as s:
    s.query(ApprovalAction).filter(ApprovalAction.action_id.like("demo-%")).delete(synchronize_session=False)
    s.query(WorkflowRun).filter(WorkflowRun.run_id.like("demo-%")).delete(synchronize_session=False)
    s.query(CaseClosureInfo).filter(CaseClosureInfo.case_id.like("demo-%")).delete(synchronize_session=False)
    s.execute(case_findings.delete().where(case_findings.c.finding_id.like("demo-%")))
    s.query(Case).filter(Case.case_id.like("demo-%")).delete(synchronize_session=False)
    s.query(Finding).filter(Finding.finding_id.like("demo-%")).delete(synchronize_session=False)
    s.query(IntakeTrigger).filter(IntakeTrigger.reason == "demo").delete(synchronize_session=False)
print("demo fleet removed")
