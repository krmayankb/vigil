import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PgContentStore } from "../../ledger/content.js";
import { TEST_DSN } from "../support/testdb.js";

const pool = new pg.Pool({ connectionString: TEST_DSN });
const written: string[] = [];
afterAll(async () => {
  // The app role cannot delete; the test's own role can.
  await pool.query("DELETE FROM agent_content WHERE hash = ANY($1::text[])", [written]);
  await pool.end();
});

const piece = (text: string) => {
  const hash = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  written.push(hash);
  return { hash, text };
};

describe("the content store", () => {
  it("keeps one copy of a piece of text however often it is put", async () => {
    const one = piece(`system prompt ${Math.random()}`);
    const store = new PgContentStore(pool);
    await store.put([one, one]);
    await new PgContentStore(pool).put([one]);
    const rows = await pool.query("SELECT count(*)::int AS n FROM agent_content WHERE hash = $1", [one.hash]);
    expect(rows.rows[0].n).toBe(1);
    expect((await store.get([one.hash, "sha256:absent"])).get(one.hash)).toBe(one.text);
  });

  it("refuses text that does not hash to its name", async () => {
    await expect(new PgContentStore(pool).put([{ hash: "sha256:not-the-hash", text: "anything" }])).rejects.toThrow(/agent_content_hash_matches/);
  });
});
