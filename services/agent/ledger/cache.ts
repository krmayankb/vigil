import type { AgentEvent, NewEvent, TerminalPayload } from "../contracts/events.js";
import type { ReadOptions, State } from "../core/seams.js";

// A store that hands back what it wrote, as stored: the ledger repository does.
export interface ReturningState<Kinds extends Record<string, unknown>> extends State<Kinds> {
  appendReturning(runId: string, events: readonly NewEvent<Kinds>[]): Promise<AgentEvent<Kinds>[]>;
}

// The worker's view of the ledger. Once a run has been read, this process holds its
// ledger and adds to it every row it writes, so later reads are answered from memory
// with no query. The kernel re-reads a run's ledger many times a turn, and at load
// those reads were a third of the database's time.
//
// Sound because one process drives a run at a time (the lease), every event of a run
// this process drives is appended through here, and the backend never writes
// agent_events. The worker forgets a run when its job lets go, so a run that parks
// and resumes elsewhere is read whole again. Snapshot reads bypass the cache.
export class CachedLedger<Kinds extends Record<string, unknown> = Record<never, never>> implements State<Kinds> {
  private readonly runs = new Map<string, AgentEvent<Kinds>[]>();
  // Appends per run, so a read that was out while one landed knows to catch up.
  private readonly writes = new Map<string, number>();

  constructor(
    private readonly inner: State<Kinds> | ReturningState<Kinds>,
    // Runs kept, least recently used dropped first; a dropped run is read whole again.
    private readonly capacity = 5_000,
  ) {}

  latestSeq(runId: string): Promise<number | null> {
    const held = this.runs.get(runId);
    if (held !== undefined) return Promise.resolve(held.length === 0 ? null : held[held.length - 1]!.seq);
    return this.inner.latestSeq(runId);
  }

  terminal(runId: string): Promise<TerminalPayload | null> {
    return this.inner.terminal(runId);
  }

  async read(runId: string, opts: ReadOptions = {}): Promise<AgentEvent<Kinds>[]> {
    if (opts.snapshots === true) return this.inner.read(runId, opts);
    let held = this.runs.get(runId);
    if (held === undefined) {
      const before = this.writes.get(runId) ?? 0;
      held = await this.inner.read(runId);
      // A write that landed while the read was out may be missing from it: catch up.
      if ((this.writes.get(runId) ?? 0) !== before) {
        const next = held.length === 0 ? 0 : held[held.length - 1]!.seq + 1;
        held = [...held, ...(await this.inner.read(runId, { since: next }))];
      }
      this.keep(runId, held);
    }
    const since = opts.since ?? 0;
    return since === 0 ? [...held] : held.filter((event) => event.seq >= since);
  }

  async append(runId: string, events: readonly NewEvent<Kinds>[]): Promise<number> {
    if (events.length === 0) return this.inner.append(runId, events);
    this.writes.set(runId, (this.writes.get(runId) ?? 0) + 1);
    if (!("appendReturning" in this.inner)) {
      // A store that cannot say what it wrote: drop the copy and read it back.
      this.runs.delete(runId);
      return this.inner.append(runId, events);
    }
    let written: AgentEvent<Kinds>[];
    try {
      written = await this.inner.appendReturning(runId, events);
    } catch (error) {
      // Whether anything landed is unknown, so the held copy can no longer be trusted.
      this.runs.delete(runId);
      throw error;
    }
    const held = this.runs.get(runId);
    const first = written[0]!.seq;
    const last = held === undefined || held.length === 0 ? -1 : held[held.length - 1]!.seq;
    // Added only when it continues what is held. Anything else -- a run not read yet,
    // or a gap that says another writer was here -- is read whole next time.
    if (held !== undefined && first === last + 1) this.keep(runId, [...held, ...written]);
    else this.runs.delete(runId);
    if (events.some((event) => event.kind === "terminal")) this.forget(runId);
    return written[written.length - 1]!.seq + 1;
  }

  // For a caller that knows this process is done driving a run.
  forget(runId: string): void {
    this.runs.delete(runId);
    this.writes.delete(runId);
  }

  private keep(runId: string, events: AgentEvent<Kinds>[]): void {
    this.runs.delete(runId);
    this.runs.set(runId, events);
    if (this.runs.size > this.capacity) this.runs.delete(this.runs.keys().next().value as string);
  }
}
