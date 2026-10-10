import OpenAI from "openai";
import type { RunKind } from "./contracts/events.js";
import type { ToolPrincipal } from "./contracts/tool.js";
import { budgetOf, FRESH, unmeteredQuota, type Seed } from "./core/budget.js";
import { httpPrices } from "./core/prices.js";
import { Limiter } from "./core/limiter.js";
import { fleetLimitsFrom, openGate, RedisGate, type Gate } from "./core/fleet-gate.js";
import { fleetBudgetLimitsFrom, RedisFleetBudget, unboundedBudget, type FleetBudget } from "./core/fleet-budget.js";
import { runNow } from "./core/lane.js";
import type { Budget } from "./contracts/budget.js";
import type { RegisteredTool } from "./contracts/tool.js";
import { sharedRedis } from "./core/db.js";
import type { Harness } from "./core/loop.js";
import { nullMemory } from "./core/memory.js";
import { httpRecall } from "./core/recall.js";
import { registryOf } from "./core/registry.js";
import { remoteDispatch } from "./core/remote.js";
import type { Memory, State } from "./core/seams.js";
import type { RunSpec } from "./core/spec.js";
import { httpVirtualKey } from "./core/vk.js";
import { openAiSurface } from "./core/wire.js";
import { toolsFrom } from "./tools/remote.js";

// One name for the shared secret on both sides of the boundary — Python reads it
// as AGENT_INTERNAL_TOKEN. VIGIL_TOOLS_TOKEN is the older spelling, still read.
export function internalToken(): string {
  return process.env["AGENT_INTERNAL_TOKEN"] ?? process.env["VIGIL_TOOLS_TOKEN"] ?? "";
}

// One per process, not one per run. A client per run opens its own connection pool
// and reuses no keep-alive; a limiter per run means N runs get N times the rate.
// /v1 is Bifrost's OpenAI-format surface and BIFROST_URL names the gateway, not
// that surface: core/llm/router/router.py appends the same suffix to the same
// variable. Without it every call reaches the gateway root and answers 405.
//
// maxRetries: 0 because the limiter is the retry policy. The SDK's own default would
// multiply against the limiter's and the gateway's, billing every attempt.
const client = new OpenAI({
  baseURL: `${(process.env["BIFROST_URL"] ?? "http://bifrost:8080").replace(/\/+$/, "")}/v1`,
  apiKey: process.env["BIFROST_API_KEY"] ?? "unused",
  maxRetries: 0,
  timeout: Number(process.env["VIGIL_LLM_TIMEOUT_MS"] ?? 600_000),
});

// Per process: N replicas send up to N times these. Overridable so a deployment
// can size them to its gateway, and a soak run can measure past them.
const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
// The fleet's allowance, shared through Redis by every replica: VIGIL_LLM_FLEET_
// CONCURRENCY, _RPM and _TPM. Unset, there is none, and each process keeps only its own.
const fleetLlm = fleetLimitsFrom("VIGIL_LLM_FLEET");
const llmTimeoutMs = Number(process.env["VIGIL_LLM_TIMEOUT_MS"] ?? 600_000);
const limiter = new Limiter(
  { rpm: envInt("VIGIL_LLM_RPM", 500), tpm: envInt("VIGIL_LLM_TPM", 400_000) },
  envInt("VIGIL_LLM_CONCURRENCY", 4),
  3,
  fleetLlm === null ? openGate : new RedisGate(sharedRedis(), "llm", fleetLlm, llmTimeoutMs + 30_000),
  // Model calls in flight for the human lane, beside the automated ones.
  envInt("VIGIL_LLM_HUMAN_CONCURRENCY", Math.max(1, Math.round(envInt("VIGIL_LLM_CONCURRENCY", 4) / 4))),
);

// The fleet's allowance per tool backend: a tool's own max_inflight in the config,
// else VIGIL_TOOL_FLEET_CONCURRENCY for every remote tool. A thousand runs querying
// one SIEM is the SIEM's outage, whatever each worker allows itself.
const toolDefault = envInt("VIGIL_TOOL_FLEET_CONCURRENCY", 0);
const toolGates = new Map<string, Gate>();
function toolGate(spec: RunSpec): (tool: RegisteredTool) => Gate {
  return (tool) => {
    const declared = spec.tools.find((one) => one.id === tool.id)?.["max_inflight"];
    const limit = typeof declared === "number" && Number.isInteger(declared) && declared > 0 ? declared : toolDefault;
    if (limit === 0) return openGate;
    const key = `${tool.id}:${limit}`;
    let gate = toolGates.get(key);
    if (gate === undefined) {
      gate = new RedisGate(sharedRedis(), `tool:${tool.id}`, { concurrency: limit }, tool.bounds.timeoutMs + 30_000);
      toolGates.set(key, gate);
    }
    return gate;
  };
}

// What the whole fleet may spend per hour and per day (VIGIL_FLEET_BUDGET_HOURLY_USD,
// _DAILY_USD). The worker admits automated starts against it and settles each run
// when it ends; every priced call is charged to it here, to the run in whose context
// the call was made -- a child run's to its parent, as its spend already is.
const fleetLimits = fleetBudgetLimitsFrom();
export const fleetBudget: FleetBudget = fleetLimits === null ? unboundedBudget : new RedisFleetBudget(sharedRedis(), fleetLimits);

function charged(inner: Budget): Budget {
  if (fleetBudget === unboundedBudget) return inner;
  return {
    get limits() {
      return inner.limits;
    },
    get spent() {
      return inner.spent;
    },
    beginCall: () => inner.beginCall(),
    raise: (limits) => inner.raise(limits),
    release: () => inner.release(),
    priceOf: (modelId, providerType, tokens) => inner.priceOf(modelId, providerType, tokens),
    record: (payload) => {
      inner.record(payload);
      const run = runNow();
      if (run !== undefined && payload.cost_usd !== null) void fleetBudget.charge(run, payload.cost_usd);
    },
  };
}

// Memoised across runs, since a per-run memo dies with the run, but only for as long
// as the backend keeps its own copy: MODEL_CATALOG_REFRESH_INTERVAL_S is the variable
// core/config.py reads, and its default there.
const pricing = {
  url: process.env["VIGIL_PRICING_URL"] ?? "http://localhost:6987/internal/pricing",
  token: internalToken(),
  ttlMs: Number(process.env["MODEL_CATALOG_REFRESH_INTERVAL_S"] ?? 300) * 1000,
};
const prices = httpPrices(pricing);

// The Settings → Budgets key, sent on every model call so Bifrost's budget binds
// agent runs too. Read per process, never carried in a RunSpec.
const vk = httpVirtualKey(pricing);

// The six injected parts, assembled per run because the model, the grants and the
// budget are all the spec's. Nothing here is shared between two runs.
// The gateway's own namespacing: "<provider>/<model>". Left bare when the spec
// names no provider, which is every config written before this field existed.
function wireModel(spec: { model: string; provider?: string }): string {
  return spec.provider ? `${spec.provider}/${spec.model}` : spec.model;
}

export function harnessFor<K extends Record<string, unknown>>(
  kind: RunKind,
  spec: RunSpec,
  state: State<K>,
  memory: Memory = nullMemory,
  seed: Seed = FRESH,
  principal?: ToolPrincipal,
): Harness<K> {
  const tools = process.env["VIGIL_TOOLS_URL"] ?? "http://localhost:6987/internal/tools/invoke";
  return {
    // Bare id for pricing, namespaced id on the wire — see openAiSurface. Without
    // the namespace the gateway matched "gemini-2.5-flash" to whichever provider
    // claimed it first, so a chat pointed at Vertex was answered (or refused) by
    // a different account entirely. The same provider is handed to pricing: the
    // gateway bills nothing of its own, and a catalog left to guess from the
    // model's name priced a paid "llama" on a commercial host at $0.
    provider: openAiSurface(client, spec.model, limiter, spec.provider ?? "bifrost", wireModel(spec), vk, spec.effort),
    // Grants nobody here: every run is a plugin on the kernel, which registers the
    // deployment's tools itself and grants them by the plugin's needs.
    registry: registryOf(toolsFrom(spec.tools), {}),
    dispatch: remoteDispatch({ url: tools, token: internalToken(), gate: toolGate(spec), ...(principal === undefined ? {} : { principal }) }),
    budget: charged(budgetOf(spec.budgets, unmeteredQuota, Date.now, seed, prices)),
    // Wrapped rather than replaced: whatever the caller passed still answers the
    // cue-shaped recall, and the keyed read is added over the same endpoint the
    // tools go to -- one address for the far side, not two to keep in step.
    memory: httpRecall(memory, { url: tools, token: internalToken() }),
    state,
  };
}

// Injected so a test drives a run without a provider behind it. The seam is the
// harness itself, which is the only part of a run that reaches outside the process.
export type HarnessFactory = <K extends Record<string, unknown>>(
  kind: RunKind,
  spec: RunSpec,
  state: State<K>,
  memory?: Memory,
  seed?: Seed,
  // Only chat has a person behind it; the worker and hunts pass none.
  principal?: ToolPrincipal,
) => Harness<K>;
