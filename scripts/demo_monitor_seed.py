"""Demo fleet for Fleet Wall and Pulse. Every row is tagged demo- (intake rows: reason demo). No row is queued, so the daemon starts nothing."""
import random
from datetime import timedelta
from core.storage.connection import get_db_manager
from core.storage.models import ApprovalAction, Case, CaseClosureInfo, Finding, IntakeTrigger, WorkflowRun, case_findings
from core.storage.unit_of_work import unit_of_work
from core.time import utcnow

get_db_manager().initialize()
random.seed(7)
now = utcnow()
WF = [("full-investigation", "Full Investigation", 70), ("threat-hunt", "Threat Hunt", 30), ("incident-response", "Incident Response", 18), ("root-cause-analysis", "Root Cause Analysis", 12), ("forensic-analysis", "Forensic Analysis", 9)]
with unit_of_work() as s:
    s.query(ApprovalAction).filter(ApprovalAction.action_id.like("demo-%")).delete(synchronize_session=False)
    s.query(WorkflowRun).filter(WorkflowRun.run_id.like("demo-%")).delete(synchronize_session=False)
    s.query(CaseClosureInfo).filter(CaseClosureInfo.case_id.like("demo-%")).delete(synchronize_session=False)
    s.execute(case_findings.delete().where(case_findings.c.finding_id.like("demo-%")))
    s.query(Case).filter(Case.case_id.like("demo-%")).delete(synchronize_session=False)
    s.query(Finding).filter(Finding.finding_id.like("demo-%")).delete(synchronize_session=False)
    s.query(IntakeTrigger).filter(IntakeTrigger.reason == "demo").delete(synchronize_session=False)
    n = 0
    for wf, name, k in WF:
        for i in range(k):
            n += 1
            cid = f"demo-{n:04d}"
            created = now - timedelta(minutes=random.randint(20, 1400))
            s.add(Case(case_id=cid, title=random.choice(["Beaconing from", "Credential theft on", "Encoded PowerShell on", "Impossible travel for", "Large upload from"]) + f" WS-{random.randint(100,999)}", description="Formed by triage from alerts on one host.", status="open", priority=random.choice(["critical","high","high","medium","low"]), created_at=created, updated_at=created))
            s.flush()
            alerts = random.choice([1,1,1,2,3,6])
            for a in range(alerts):
                fid = f"demo-f{n:04d}-{a}"
                s.add(Finding(finding_id=fid, data_source=random.choice(["edr","siem","loglm"]), created_at=created - timedelta(minutes=a), status="new", severity="high"))
                s.flush()
                s.execute(case_findings.insert().values(case_id=cid, finding_id=fid, added_at=created))
            r = random.random()
            status = "running" if r < 0.78 else "paused" if r < 0.88 else None
            if status:
                s.add(WorkflowRun(run_id=f"demo-r{n:04d}", workflow_id=wf, workflow_name=name, status=status, trigger_context={"case_id": cid}, started_at=created + timedelta(minutes=1), total_cost_usd=round(random.uniform(0.05, 2.5), 3)))
            if status == "paused" and random.random() < 0.7:
                s.add(ApprovalAction(action_id=f"demo-a{n:04d}", action_type="isolate_host", title=f"Isolate host for {cid}", description="d", target="host", confidence=0.8, reason="beaconing to a known C2", evidence=[], created_by="agent", requires_approval=True, status="pending", parameters={"case_id": cid}, created_at=now - timedelta(minutes=random.randint(3, 300))))
    # closed today and yesterday, finished runs with cost, decisions answered
    for j in range(260):
        cid = f"demo-c{j:04d}"
        closed = now - timedelta(minutes=random.randint(1, 60*36))
        s.add(Case(case_id=cid, title="Closed case", status="closed", priority="medium", created_at=closed - timedelta(hours=1), updated_at=closed))
        s.flush()
        s.add(CaseClosureInfo(case_id=cid, closure_category=random.choice(["resolved","false_positive"]), closed_by="agent" if random.random() < 0.86 else "ada", closed_by_kind="agent" if random.random() < 0.86 else "analyst", closed_at=closed))
        wf = random.choice(WF)[0]
        s.add(WorkflowRun(run_id=f"demo-rc{j:04d}", workflow_id=wf, workflow_name=wf, status="completed", trigger_context={"case_id": cid}, started_at=closed - timedelta(minutes=40), finished_at=closed, total_cost_usd=round(random.uniform(0.2, 3.0), 3)))
    for j in range(40):
        asked = now - timedelta(minutes=random.randint(30, 1300))
        s.add(ApprovalAction(action_id=f"demo-d{j:04d}", action_type="block_ip", title="Block", description="d", target="x", confidence=0.8, reason="r", evidence=[], created_by="agent", requires_approval=True, status="approved", parameters={}, created_at=asked, approved_at=asked + timedelta(minutes=random.randint(1, 25)), approved_by="ada"))
    for j in range(600):
        at = now - timedelta(minutes=random.randint(1, 1439))
        s.add(Finding(finding_id=f"demo-x{j:04d}", data_source="edr", created_at=at, status="new", severity="medium"))
    for j in range(120):
        at = now - timedelta(minutes=random.randint(1, 1439))
        s.add(IntakeTrigger(kind="detection", state=random.choice(["launched","launched","merged"]), reason="demo", priority="medium", payload={}, created_at=at, decided_at=at + timedelta(minutes=random.randint(1, 90))))
print("seeded", n, "open cases")
