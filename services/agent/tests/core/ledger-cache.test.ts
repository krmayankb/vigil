import { describe, expect, it } from "vitest";
import type { AgentEvent, NewEvent } from "../../contracts/events.js";
import type { ReadOptions } from "../../core/seams.js";
import { InProcessState } from "../../core/state.js";
import { CachedLedger, type ReturningState } from "../../ledger/cache.js";

const RUN = "00000000-0000-4000-8000-000000000001";
const ev = (kind: string, payload: unknown = {}): NewEvent<Record<never, never>> => ({ run_id: RUN, run_kind: "investigate", kind, payload }) as unknown as NewEvent<Record<never, never>>;

// An in-process store that hands back what it wrote, as the repository does, and
// counts the reads that reach it.
function store() {
  const inner = new InProcessState() as InProcessState & ReturningState<Record<never, never>>;
  const asked: ReadOptions[] = [];
  const read = inner.read.bind(inner);
  inner.read = async (runId: string, opts: ReadOptions = {}) => {
    asked.push(opts);
    return read(runId, opts);
  };
  inner.appendReturning = async (runId: string, events: readonly NewEvent<Record<never, never>>[]): Promise<AgentEvent<Record<never, never>>[]> => {
    const next = await inner.append(runId, events);
    return (await read(runId, { since: next - events.length })) as AgentEvent<Record<never, never>>[];
  };
  return { inner, asked };
}

describe("a worker's cached view of a run's ledger", () => {
  it("reads a run once, then answers from what it wrote", async () => {
    const { inner, asked } = store();
    const ledger = new CachedLedger(inner);
    await ledger.append(RUN, [ev("run"), ev("spend")]);
    expect((await ledger.read(RUN)).map((one) => one.kind)).toEqual(["run", "spend"]);
    await ledger.append(RUN, [ev("call")]);
    expect((await ledger.read(RUN)).map((one) => one.kind)).toEqual(["run", "spend", "call"]);
    expect(await ledger.latestSeq(RUN)).toBe(2);
    expect(asked).toEqual([{}]);
  });

  it("answers a since read from what it holds", async () => {
    const { inner } = store();
    const ledger = new CachedLedger(inner);
    await ledger.append(RUN, [ev("run"), ev("spend"), ev("call")]);
    expect((await ledger.read(RUN, { since: 1 })).map((one) => one.seq)).toEqual([1, 2]);
    expect(await ledger.read(RUN, { since: 3 })).toEqual([]);
  });

  it("catches up on a write that landed while its first read was out", async () => {
    const { inner } = store();
    const ledger = new CachedLedger(inner);
    await inner.append(RUN, [ev("run")]);
    const reading = ledger.read(RUN);
    await ledger.append(RUN, [ev("spend")]);
    expect((await reading).map((one) => one.kind)).toEqual(["run", "spend"]);
    expect((await ledger.read(RUN)).map((one) => one.kind)).toEqual(["run", "spend"]);
  });

  it("reads whole again after a gap, a forget, or the run ending", async () => {
    const { inner, asked } = store();
    const ledger = new CachedLedger(inner);
    await ledger.append(RUN, [ev("run")]);
    await ledger.read(RUN);
    await inner.append(RUN, [ev("spend")]); // another writer
    await ledger.append(RUN, [ev("call")]); // continues seq 2, after a row it never saw
    expect((await ledger.read(RUN)).map((one) => one.kind)).toEqual(["run", "spend", "call"]);
    ledger.forget(RUN);
    await ledger.read(RUN);
    await ledger.append(RUN, [ev("terminal", { outcome: "completed", reason: "done" })]);
    await ledger.read(RUN);
    expect(asked).toEqual([{}, {}, {}, {}]);
  });

  it("passes snapshot reads straight through, and hands back copies", async () => {
    const { inner, asked } = store();
    const ledger = new CachedLedger(inner);
    await ledger.append(RUN, [ev("run")]);
    await ledger.read(RUN, { snapshots: true });
    expect(asked).toEqual([{ snapshots: true }]);
    (await ledger.read(RUN)).pop();
    expect(await ledger.read(RUN)).toHaveLength(1);
  });

  it("works over a store that cannot say what it wrote, by reading back", async () => {
    const inner = new InProcessState();
    const ledger = new CachedLedger(inner);
    await ledger.append(RUN, [ev("run")]);
    await ledger.read(RUN);
    await ledger.append(RUN, [ev("spend")]);
    expect((await ledger.read(RUN)).map((one) => one.kind)).toEqual(["run", "spend"]);
  });
});
