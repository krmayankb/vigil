import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Publication } from "../../core/shared-findings.js";
import { PgSharedFindings } from "../../ledger/shared-findings.js";
import { TEST_DSN } from "../support/testdb.js";

const pool = new pg.Pool({ connectionString: TEST_DSN });
const shared = new PgSharedFindings(pool);
const keysUsed: string[] = [];
afterAll(async () => {
  await pool.query("DELETE FROM entity_findings WHERE entity_key = ANY($1::text[])", [keysUsed]);
  await pool.end();
});

// An entity of this test's own, so another suite's rows never count here.
const entity = () => {
  const key = `host:test-${randomUUID()}`;
  keysUsed.push(key);
  return key;
};

const finding = (keys: string[], run: string, source: number, statement = `said at ${source}`): Publication => ({
  entity_keys: keys,
  run_id: run,
  run_kind: "investigate",
  source_seq: source,
  kind: "observation",
  statement,
  detail: {},
  attacker_influenceable: true,
  derived_from: [],
});

describe("findings shared between runs, by entity", () => {
  it("numbers each entity's findings in order, and reads only what is newer than a run has seen", async () => {
    const host = entity();
    const [a, b, me] = [randomUUID(), randomUUID(), randomUUID()];
    await shared.publish([finding([host], a, 3), finding([host], a, 5)]);
    await shared.publish([finding([host], b, 2)]);

    const first = await shared.since([host], {}, me, 20);
    expect(first.findings.map((one) => one.seq).sort()).toEqual([1, 2, 3]);
    expect(first.latest).toEqual({ [host]: 3 });

    await shared.publish([finding([host], b, 9)]);
    const second = await shared.since([host], first.latest, me, 20);
    expect(second.findings.map((one) => [one.seq, one.run_id])).toEqual([[4, b]]);
  });

  it("never shows a run its own findings", async () => {
    const host = entity();
    const me = randomUUID();
    await shared.publish([finding([host], me, 1)]);
    expect((await shared.since([host], {}, me, 20)).findings).toEqual([]);
    expect(await shared.latest([host], me)).toEqual({});
  });

  it("writes nothing twice when a publish is retried", async () => {
    const host = entity();
    const run = randomUUID();
    await shared.publish([finding([host], run, 7)]);
    await shared.publish([finding([host], run, 7)]);
    expect((await shared.since([host], {}, randomUUID(), 20)).findings).toHaveLength(1);
  });

  it("files one finding under every entity it is about", async () => {
    const [host, ip] = [entity(), entity()];
    await shared.publish([finding([host, ip], randomUUID(), 1)]);
    const read = await shared.since([host, ip], {}, randomUUID(), 20);
    expect(read.findings.map((one) => one.entity_key).sort()).toEqual([host, ip].sort());
    expect(read.latest).toEqual({ [host]: 1, [ip]: 1 });
  });

  it("returns at most the limit, newest first, and says how many it left out", async () => {
    const host = entity();
    const run = randomUUID();
    await shared.publish(Array.from({ length: 5 }, (_, i) => finding([host], run, i)));
    const read = await shared.since([host], {}, randomUUID(), 2);
    expect(read.findings).toHaveLength(2);
    expect(read.omitted).toBe(3);
    expect(read.latest).toEqual({ [host]: 5 });
  });

  it("gives every finding its own seq when many runs publish on one entity at once", async () => {
    const host = entity();
    await Promise.all(Array.from({ length: 20 }, (_, i) => shared.publish([finding([host], randomUUID(), i)])));
    const read = await shared.since([host], {}, randomUUID(), 100);
    expect(read.findings.map((one) => one.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe("when a finding happened, beside when it was shared", () => {
  it("keeps the time the run saw it", async () => {
    const host = entity();
    await shared.publish([{ ...finding([host], randomUUID(), 1), observed_at: "2026-10-01T08:00:00.000Z" }]);
    const [read] = (await shared.since([host], {}, randomUUID(), 20)).findings;
    expect(read!.observed_at).toBe("2026-10-01T08:00:00.000Z");
    expect(Date.parse(read!.recorded_at)).toBeGreaterThan(Date.parse(read!.observed_at!));
  });
});

describe("an entity many runs have worked", () => {
  it("is summed up when one read cannot show it all", async () => {
    const host = entity();
    const conclusion = (run: string, source: number, disposition: string): Publication => ({ ...finding([host], run, source), kind: "conclusion", detail: { answer: { disposition } } });
    const runs = Array.from({ length: 4 }, () => randomUUID());
    await shared.publish([conclusion(runs[0]!, 1, "malicious"), conclusion(runs[1]!, 1, "malicious"), conclusion(runs[2]!, 1, "benign"), finding([host], runs[3]!, 1)]);
    await pool.query("UPDATE entity_findings SET status = 'superseded' WHERE entity_key = $1 AND run_id = $2", [host, runs[2]]);

    const read = await shared.since([host], {}, randomUUID(), 2);
    expect(read.findings).toHaveLength(2);
    expect(read.omitted).toBe(2);
    expect(read.digest?.[host]).toEqual({ runs: 4, standing: { malicious: 2 }, superseded: 1, retractions: 0 });

    // Everything fits: no digest to read.
    expect((await shared.since([host], {}, randomUUID(), 20)).digest).toBeUndefined();
  });
});
