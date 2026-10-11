import { readFileSync } from "node:fs";
import { join } from "node:path";

// Scores eval/memory-ablation.ts. Two tables.
//
// Tags: for each tag, the history runs it marked weak against the rest, and how
// often each group's own answer was wrong (an attack called benign, or the
// reverse). A tag worth filtering on marks runs that are wrong more often.
//
// Arms: each filter against `all` on the pairs where it removed something --
// elsewhere it is `all` by construction and was not rerun.
//
//   npx tsx eval/ablation-score.ts eval/results/ablation-ab1

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: tsx eval/ablation-score.ts <results dir>");
const lines = <T>(file: string): T[] => readFileSync(join(dir, file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);

type Tags = Record<string, unknown>;
const history = lines<{ pair: string; side: string; truth: string; filed: { tags: Tags; answer: string | null } }>("history.jsonl");
const targets = lines<{ pair: string; arm: string; truth: string; verdict: string | null; disposition: string | null; cost_usd: number; runs_filtered_out: number }>("targets.jsonl");

const WEAK: Record<string, (tags: Tags) => boolean> = {
  review: (tags) => tags["review"] === "overturn" || tags["review"] === "insufficient",
  rests_on_other_runs: (tags) => tags["rests_on_other_runs"] === true,
  held: (tags) => tags["held"] === true,
  run_outcome: (tags) => tags["run_outcome"] !== "completed",
};

const sideOf = (answer: string | null) => (answer === "malicious" || answer === "suspicious" ? "attack" : answer === "benign" || answer === "false_positive" ? "benign" : "undetermined");
const wrong = (truth: string, said: string) => said !== "undetermined" && said !== truth;
const pct = (n: number, d: number) => (d === 0 ? "–" : `${Math.round((100 * n) / d)}%`);

console.log(`history: ${history.length} runs over ${new Set(history.map((one) => one.pair)).size} pairs\n`);
console.log("| tag | runs marked weak | wrong when marked | wrong when not | undetermined when marked |");
console.log("|---|---|---|---|---|");
for (const [tag, weak] of Object.entries(WEAK)) {
  const marked = history.filter((one) => weak(one.filed.tags));
  const rest = history.filter((one) => !weak(one.filed.tags));
  const w = (group: typeof history) => group.filter((one) => wrong(one.truth, sideOf(one.filed.answer))).length;
  const u = marked.filter((one) => sideOf(one.filed.answer) === "undetermined").length;
  console.log(`| ${tag} | ${marked.length} / ${history.length} | ${w(marked)} / ${marked.length} (${pct(w(marked), marked.length)}) | ${w(rest)} / ${rest.length} (${pct(w(rest), rest.length)}) | ${u} / ${marked.length} |`);
}

// The grader's verdict, falling back to the run's own answer when it could not grade.
const said = (one: (typeof targets)[number]) => one.verdict ?? sideOf(one.disposition);
const stats = (group: typeof targets) => {
  const attacks = group.filter((one) => one.truth === "attack");
  const benign = group.filter((one) => one.truth === "benign");
  return {
    n: group.length,
    missed: attacks.filter((one) => said(one) === "benign").length,
    caught: attacks.filter((one) => said(one) === "attack").length,
    attacks: attacks.length,
    closed: benign.filter((one) => said(one) === "benign").length,
    false_alarms: benign.filter((one) => said(one) === "attack").length,
    benign: benign.length,
    right: group.filter((one) => said(one) === one.truth).length,
    cost: group.reduce((sum, one) => sum + one.cost_usd, 0) / Math.max(1, group.length),
  };
};
const row = (name: string, s: ReturnType<typeof stats>, extra: string) =>
  `| ${name} | ${s.n} | ${s.missed} / ${s.attacks} | ${s.caught} / ${s.attacks} | ${s.closed} / ${s.benign} | ${s.false_alarms} | ${pct(s.right, s.n)} | $${s.cost.toFixed(3)} | ${extra} |`;

console.log("\n| arm | runs | missed attacks | attacks caught | benign closed | false alarms | right | cost/case | vs all, same pairs |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const arm of ["none", "all", "review", "rests_on_other_runs", "held", "run_outcome"]) {
  const mine = targets.filter((one) => one.arm === arm);
  if (mine.length === 0) {
    console.log(`| ${arm} | 0 | – | – | – | – | – | – | removed nothing in any pair |`);
    continue;
  }
  const pairs = new Set(mine.map((one) => one.pair));
  const base = stats(targets.filter((one) => one.arm === "all" && pairs.has(one.pair)));
  const s = stats(mine);
  const extra = arm === "all" ? "" : `${pairs.size} pairs; right ${pct(s.right, s.n)} vs ${pct(base.right, base.n)}, missed ${s.missed} vs ${base.missed}`;
  console.log(row(arm, s, extra));
}
