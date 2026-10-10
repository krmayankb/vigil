import { describe, expect, it } from "vitest";
import { Limiter, ProviderUnavailable } from "../../core/limiter.js";

// Two attempts, no wait to speak of: the retry policy, not the clock, is under test.
const limiter = () => new Limiter({ rpm: 10_000, tpm: 10_000_000 }, 4, 2);
const failing = (error: unknown) => async () => {
  throw error;
};

describe("the model limiter, when the provider will not answer", () => {
  it("gives up on a rate limit as the provider being unavailable, not the call failing", async () => {
    const error = Object.assign(new Error("429 Too Many Requests"), { status: 429, headers: { "retry-after": "0" } });
    const thrown = await limiter().run(10, failing(error)).catch((caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(ProviderUnavailable);
    expect((thrown as ProviderUnavailable).status).toBe(429);
    expect((thrown as Error).message).toContain("429 Too Many Requests");
  });

  it("says the same of a socket that never answered", async () => {
    const thrown = await limiter().run(10, failing(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }))).catch((caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(ProviderUnavailable);
  });

  it("passes a request the provider rejected through unchanged", async () => {
    const error = Object.assign(new Error("400 Bad Request"), { status: 400 });
    await expect(limiter().run(10, failing(error))).rejects.toBe(error);
  });

  it("passes a defect in this process and a cancelled call through unchanged", async () => {
    const defect = new TypeError("x is not a function");
    await expect(limiter().run(10, failing(defect))).rejects.toBe(defect);
    const cancelled = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(limiter().run(10, failing(cancelled))).rejects.toBe(cancelled);
  });
});

describe("the model limiter, with a person waiting", () => {
  it("gives a human run's call its own slot while automated calls fill theirs", async () => {
    const { inLane } = await import("../../core/lane.js");
    const limiter = new Limiter({ rpm: 10_000, tpm: 10_000_000 }, 1, 1, undefined, 1);
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const automated = limiter.run(1, () => held);
    const queued = limiter.run(1, async () => "automated, second");
    const human = await inLane("human", () => limiter.run(1, async () => "human"));
    expect(human).toBe("human");
    release();
    await automated;
    expect(await queued).toBe("automated, second");
  });
});
