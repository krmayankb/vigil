import type { Pool, PoolClient } from "pg";
import {
  EVENT_SCHEMA_VERSION,
  type AgentEvent,
  type NewEvent,
  type RunKind,
  type TerminalPayload,
} from "../contracts/events.js";
import type { ReadOptions } from "../core/seams.js";

// Two writers reached the same ledger position. Retried once inside append, so
// reaching a caller means the run is genuinely being driven twice.
export class SeqConflict extends Error {
  constructor(readonly runId: string, readonly seq: number) {
    super(`ledger position ${runId}/${seq} is already taken`);
  }
}

const UNIQUE_VIOLATION = "23505";

const FOLD_COLUMNS = "run_id, run_kind, seq, ts, kind, payload, schema_version";
const SNAPSHOT_COLUMNS = `${FOLD_COLUMNS}, snapshot`;

// The single writer to agent_events. Assigns seq itself, so no
// caller chooses its own position in the log.
export class LedgerRepository<Kinds extends Record<string, unknown> = Record<never, never>> {
  constructor(private readonly pool: Pool) {}

  async latestSeq(runId: string): Promise<number | null> {
    const result = await this.pool.query<{ max: number | null }>(
      "SELECT MAX(seq) AS max FROM agent_events WHERE run_id = $1",
      [runId],
    );
    return result.rows[0]?.max ?? null;
  }

  // snapshot is selected only when asked for: it holds the digest presented to
  // the lead, which the fold never reads and a long run measures in megabytes.
  async read(runId: string, opts: ReadOptions = {}): Promise<AgentEvent<Kinds>[]> {
    const columns = opts.snapshots === true ? SNAPSHOT_COLUMNS : FOLD_COLUMNS;
    const result = await this.pool.query(
      `SELECT ${columns} FROM agent_events WHERE run_id = $1 AND seq >= $2 ORDER BY seq`,
      [runId, opts.since ?? 0],
    );
    return result.rows.map(rowToEvent) as AgentEvent<Kinds>[];
  }

  // One transaction, so a partial iteration never lands. Each row takes the position
  // after the highest the run holds, computed in the INSERT rather than by a caller.
  async append(runId: string, events: readonly NewEvent<Kinds>[]): Promise<number> {
    if (events.length === 0) return ((await this.latestSeq(runId)) ?? -1) + 1;
    const written = await this.appendReturning(runId, events);
    return written[written.length - 1]!.seq + 1;
  }

  // The rows as stored, seq and ts included, so a caller holding the run's ledger in
  // memory can add them without reading them back.
  async appendReturning(runId: string, events: readonly NewEvent<Kinds>[]): Promise<AgentEvent<Kinds>[]> {
    // The lock serialises this layer's writers, so a violation means one that did not
    // take it. Retried once, for the writer that has since committed.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.transact(runId, events);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (attempt >= 1) throw new SeqConflict(runId, ((await this.latestSeq(runId)) ?? -1) + 1);
      }
    }
  }

  private async transact(runId: string, events: readonly NewEvent<Kinds>[]): Promise<AgentEvent<Kinds>[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Writers for one run take their turn rather than racing: held to commit, so the
      // max each reads is one nobody else is taking. Per run, so runs never block.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [runId]);
      const written = await insertAll(client, runId, events);
      await client.query("COMMIT");
      return written as AgentEvent<Kinds>[];
    } catch (error) {
      // The rollback's own failure would otherwise mask what actually went wrong.
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // One of the two queries Python is permitted against this table; it lives
  // here too so the worker and the API agree on what terminal means.
  async terminal(runId: string): Promise<TerminalPayload | null> {
    const result = await this.pool.query<{ payload: TerminalPayload }>(
      "SELECT payload FROM agent_events WHERE run_id = $1 AND kind = 'terminal' ORDER BY seq LIMIT 1",
      [runId],
    );
    return result.rows[0]?.payload ?? null;
  }
}

// Structural rather than NewEvent<Kinds>: the insert reads the envelope only,
// and never needs to know which workflow's payload union it is holding.
interface Insertable {
  run_id: string;
  run_kind: RunKind;
  kind: string;
  payload: unknown;
  snapshot?: unknown;
}

// One statement for the whole batch. The position is read once, under the run's
// lock, and the batch numbers itself from it; the composite key still rejects a
// racer that did not take the lock. The hash trigger runs per row and sees the rows
// inserted before it in the same statement, so the chain is the one a row-at-a-time
// insert built. A round trip per event was most of a run's database time at load.
async function insertAll(client: PoolClient, runId: string, events: readonly Insertable[]): Promise<AgentEvent<Record<never, never>>[]> {
  const head = await client.query<{ max: number | null }>("SELECT max(seq) AS max FROM agent_events WHERE run_id = $1", [runId]);
  const base = (head.rows[0]?.max ?? -1) + 1;
  const values: unknown[] = [];
  const rows = events.map((event, index) => {
    const at = values.length;
    values.push(
      event.run_id,
      event.run_kind,
      base + index,
      event.kind,
      JSON.stringify(event.payload),
      event.snapshot === undefined ? null : JSON.stringify(event.snapshot),
      EVENT_SCHEMA_VERSION,
    );
    return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6}, $${at + 7})`;
  });
  const result = await client.query(
    `INSERT INTO agent_events (run_id, run_kind, seq, kind, payload, snapshot, schema_version) VALUES ${rows.join(", ")}
     RETURNING ${FOLD_COLUMNS}`,
    values,
  );
  return result.rows.map(rowToEvent).sort((a, b) => a.seq - b.seq);
}

function rowToEvent(row: Record<string, unknown>): AgentEvent<Record<never, never>> {
  return {
    run_id: String(row["run_id"]),
    run_kind: row["run_kind"] as RunKind,
    seq: Number(row["seq"]),
    ts: (row["ts"] as Date).toISOString(),
    kind: String(row["kind"]),
    payload: row["payload"],
    // Absent when the fold's column list was used, null when the row carries none.
    ...(row["snapshot"] === null || row["snapshot"] === undefined ? {} : { snapshot: row["snapshot"] }),
    schema_version: Number(row["schema_version"]),
  } as AgentEvent<Record<never, never>>;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;
}
