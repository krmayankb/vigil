import type { Pool } from "pg";
import type { ContentStore } from "../core/seams.js";

// The text model calls were shown, once across every run (agent_content). A worker
// remembers which hashes it has already written, so a prompt every run shares is
// inserted once per process, not once per frame. The table checks each row's text
// against its hash, so what a replay reads back is what the frame named.
export class PgContentStore implements ContentStore {
  private readonly written = new Set<string>();

  constructor(
    private readonly pool: Pool,
    // Hashes kept in memory before the set starts over; a forgotten one costs an
    // insert that does nothing.
    private readonly capacity = 50_000,
  ) {}

  async put(pieces: readonly { hash: string; text: string }[]): Promise<void> {
    const fresh = [...new Map(pieces.filter((piece) => !this.written.has(piece.hash)).map((piece) => [piece.hash, piece])).values()];
    if (fresh.length === 0) return;
    await this.pool.query(
      "INSERT INTO agent_content (hash, text) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (hash) DO NOTHING",
      [fresh.map((piece) => piece.hash), fresh.map((piece) => piece.text)],
    );
    if (this.written.size + fresh.length > this.capacity) this.written.clear();
    for (const piece of fresh) this.written.add(piece.hash);
  }

  async get(hashes: readonly string[]): Promise<Map<string, string>> {
    if (hashes.length === 0) return new Map();
    const result = await this.pool.query<{ hash: string; text: string }>("SELECT hash, text FROM agent_content WHERE hash = ANY($1::text[])", [[...new Set(hashes)]]);
    return new Map(result.rows.map((row) => [row.hash, row.text]));
  }
}

// In memory, for tests and tools that run without a database.
export class InMemoryContentStore implements ContentStore {
  readonly held = new Map<string, string>();
  async put(pieces: readonly { hash: string; text: string }[]): Promise<void> {
    for (const piece of pieces) if (!this.held.has(piece.hash)) this.held.set(piece.hash, piece.text);
  }
  async get(hashes: readonly string[]): Promise<Map<string, string>> {
    return new Map(hashes.filter((hash) => this.held.has(hash)).map((hash) => [hash, this.held.get(hash) as string]));
  }
}
