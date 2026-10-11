import type { Pool } from "pg";
import type { EntityDigest, Publication, SharedFinding, SharedFindings, SharedUpdates } from "../core/shared-findings.js";

// entity_findings (infra/database/init/42_entity_findings.sql), the shared side of
// every run's record. Rows older than the window are not read: a finding nobody
// confirmed within it has had its chance, and the distil keeps what lasts.
export class PgSharedFindings implements SharedFindings {
  constructor(
    private readonly pool: Pool,
    private readonly windowDays = Number(process.env["VIGIL_SHARED_FINDINGS_DAYS"] ?? 7) || 7,
  ) {}

  // One transaction for the whole batch. Each entity's lock is taken in sorted
  // order, so two publishers touching the same entities cannot deadlock, and each
  // seq is the entity's next under its lock, so seqs commit in order per entity.
  async publish(rows: readonly Publication[]): Promise<void> {
    const byKey = new Map<string, Publication[]>();
    for (const row of rows) for (const key of new Set(row.entity_keys)) byKey.set(key, [...(byKey.get(key) ?? []), row]);
    if (byKey.size === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const key of [...byKey.keys()].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`entity_findings:${key}`]);
        const head = await client.query<{ max: string | null }>("SELECT max(seq) AS max FROM entity_findings WHERE entity_key = $1", [key]);
        let seq = Number(head.rows[0]?.max ?? 0);
        for (const row of byKey.get(key) ?? []) {
          const inserted = await client.query(
            `INSERT INTO entity_findings
               (entity_key, seq, run_id, run_kind, source_seq, kind, statement, detail, attacker_influenceable, derived_from, observed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11)
             ON CONFLICT (entity_key, run_id, source_seq) DO NOTHING`,
            [key, seq + 1, row.run_id, row.run_kind, row.source_seq, row.kind, row.statement, JSON.stringify(row.detail), row.attacker_influenceable, [...row.derived_from], row.observed_at ?? null],
          );
          if (inserted.rowCount === 1) seq += 1;
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async since(keys: readonly string[], watermarks: Readonly<Record<string, number>>, excludeRun: string, limit: number): Promise<SharedUpdates> {
    if (keys.length === 0) return { findings: [], omitted: 0, latest: {} };
    const marks = keys.map((key) => watermarks[key] ?? 0);
    // The newest `limit` in the database, with how many matched in all: a hot
    // entity's thousands of rows are counted there, never carried here.
    const found = await this.pool.query<Omit<SharedFinding, "recorded_at" | "observed_at" | "seq"> & { recorded_at: Date; observed_at: Date | null; seq: string; matched: string }>(
      `SELECT f.entity_key, f.seq, f.finding_id, f.run_id, f.run_kind, f.kind, f.status, f.statement, f.detail,
              f.attacker_influenceable, f.derived_from, f.recorded_at, f.observed_at, count(*) OVER () AS matched
         FROM entity_findings f
         JOIN unnest($1::text[], $2::bigint[]) AS m(entity_key, mark) ON m.entity_key = f.entity_key
        WHERE f.seq > m.mark AND f.run_id <> $3::uuid
          AND f.recorded_at > now() - make_interval(days => $4)
        ORDER BY f.recorded_at DESC, f.entity_key, f.seq DESC
        LIMIT $5`,
      [[...keys], marks, excludeRun, this.windowDays, limit],
    );
    const findings = found.rows.map(({ matched: _matched, ...row }) => ({ ...row, seq: Number(row.seq), recorded_at: row.recorded_at.toISOString(), observed_at: row.observed_at === null ? null : row.observed_at.toISOString() }));
    const omitted = Math.max(0, Number(found.rows[0]?.matched ?? 0) - findings.length);
    const latest = await this.latest(keys, excludeRun);
    // More than one read shows: the whole of what other runs said, counted.
    return omitted === 0 ? { findings, omitted, latest } : { findings, omitted, latest, digest: await this.digest(keys, excludeRun) };
  }

  // Per entity, over the window: how many runs worked it, how the conclusions that
  // still stand split by answer, and how many were superseded or retracted.
  async digest(keys: readonly string[], excludeRun: string): Promise<Record<string, EntityDigest>> {
    const rows = await this.pool.query<{ entity_key: string; runs: string; superseded: string; retractions: string; standing: Record<string, number> | null }>(
      `SELECT entity_key,
              count(DISTINCT run_id) FILTER (WHERE kind <> 'retraction') AS runs,
              count(*) FILTER (WHERE kind = 'conclusion' AND status = 'superseded') AS superseded,
              count(*) FILTER (WHERE kind = 'retraction') AS retractions,
              (SELECT jsonb_object_agg(answer, n) FROM (
                 SELECT coalesce(c.detail -> 'answer' ->> 'disposition', 'unstated') AS answer, count(*) AS n
                   FROM entity_findings c
                  WHERE c.entity_key = f.entity_key AND c.kind = 'conclusion' AND c.status <> 'superseded'
                    AND c.run_id <> $2::uuid AND c.recorded_at > now() - make_interval(days => $3)
                  GROUP BY 1) AS answers) AS standing
         FROM entity_findings f
        WHERE entity_key = ANY($1::text[]) AND run_id <> $2::uuid
          AND recorded_at > now() - make_interval(days => $3)
        GROUP BY entity_key`,
      [[...keys], excludeRun, this.windowDays],
    );
    return Object.fromEntries(
      rows.rows.map((row) => [row.entity_key, { runs: Number(row.runs), standing: row.standing ?? {}, superseded: Number(row.superseded), retractions: Number(row.retractions) }]),
    );
  }

  async latest(keys: readonly string[], excludeRun: string): Promise<Record<string, number>> {
    if (keys.length === 0) return {};
    const rows = await this.pool.query<{ entity_key: string; seq: string }>(
      `SELECT entity_key, max(seq) AS seq FROM entity_findings
        WHERE entity_key = ANY($1::text[]) AND run_id <> $2::uuid
          AND recorded_at > now() - make_interval(days => $3)
        GROUP BY entity_key`,
      [[...keys], excludeRun, this.windowDays],
    );
    return Object.fromEntries(rows.rows.map((row) => [row.entity_key, Number(row.seq)]));
  }
}
