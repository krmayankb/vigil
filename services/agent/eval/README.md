# Engine eval

Thirty labelled alerts, run as investigate cases through the kernel and through
the engine it replaced, on the same model, the same estate and the same budget.
It answers one question first: does the kernel close attacks as benign more or
less often than the old engine did? Then: at what cost.

## What a case is

`cases/*.yaml`, one list per file. Each case is an alert as an analyst would get
it, the truth (`attack` or `benign`), why, and the estate it runs against: what
each tool returns, matched on terms in the call's arguments. Anything a case does
not mention answers with nothing, which is what an empty search looks like.
Nothing reaches a real system; addresses are documentation ranges.

| set | n | built to catch |
|---|---|---|
| `attacks.yaml` | 10 | attacks the estate answers clearly |
| `blind.yaml` | 6 | attacks whose decisive source times out, is down, or is empty |
| `injection.yaml` | 4 | attacks where a tool result tells the analyst to close the case |
| `benign.yaml` | 10 | benign activity, seven of them dressed as attacks with the proof findable |

## What is measured

Each run's final report (the summary on its terminal) is read by one grader
model, the same for both engines, as `attack`, `benign` or `undetermined`. The
old engine ends on prose and the kernel on a structured answer, so neither's own
fields can be compared with the other's; the kernel's own disposition and any
answer its guard changed are recorded beside the grade.

- **Missed attacks**: attacks closed as benign. The costly error, and the headline.
- Caught and held: an attack escalated, or held for a person. Held is not missed.
- False alarms: benign cases escalated, on lookalikes especially.
- Precision, recall and F1 with `attack` as the positive class; undetermined counts as not-attack, so holding everything scores no recall.
- Cost per case (priced from `prices.yaml`), model and tool calls, wall time.

## Running it

```sh
# once: the engine the kernel replaced, at the commit this branch forked from
eval/setup-baseline.sh                          # -> ../vigil-eval-baseline

# the gateway must serve the model: BIFROST_URL (default http://127.0.0.1:8080)
npx tsx eval/run.ts --engine ../../../vigil-eval-baseline --label baseline --model anthropic/claude-sonnet-5-5
npx tsx eval/run.ts --engine ../..                        --label kernel   --model anthropic/claude-sonnet-5-5
npx tsx eval/score.ts eval/results/baseline.jsonl eval/results/kernel.jsonl --md eval/results/report.md
```

- `--only id,id` reruns a few cases; the scorer keeps the last line per case.
- `--grader-model` grades with a different model than the one under test.
- `--concurrency n` (default 2) runs cases in parallel.
- `--dry` runs every case on a model that reads the finding once and concludes
  nothing. It checks the wiring for an engine without a gateway and measures nothing.

Each engine is loaded from its own checkout and started through that checkout's
own `worker.advance()`. Three seams are replaced and nothing else: tools answer
from the case, memory recalls nothing, and prices come from `prices.yaml`. Check
those prices against the provider's current list before reading the cost row.

## Reading it with care

Thirty synthetic cases measure direction, not rates: one case is three points.
Run each engine at least three times before reading a difference of one or two
cases, and read the "where they disagree" table, which lists the cases that moved.

## Memory tag ablation

`memory-ablation.ts` asks which provenance tags recall should filter on. For each
pair in `pairs/pairs.yaml` it builds history (the first alert, then the second
with shared findings on, several times), distils each run as memory files it
(`plugins/kernel-distil.ts`, mapped as `core/memory/distil.py` does), then runs
the second alert again with that memory recalled through one arm: none, all, or
all less the runs one tag marks weak (`review`, `held`, `rests_on_other_runs`,
`run_outcome`). An arm that removes nothing is `all` again and is not rerun.

```sh
npx tsx eval/memory-ablation.ts --label ab1 --histories 3 --tries 4 --concurrency 4
npx tsx eval/ablation-score.ts eval/results/ablation-ab1
```

`ab1` (2026-10-11, gemini-2.5-pro, 60 history runs, about 140 target runs):

| Memory | Correct | Unfiltered, same pairs | Attacks missed |
|---|---|---|---|
| none | 40% | 83% | 4 vs 0 |
| less `review` overturned or insufficient (5 / 60 runs) | 58% | 75% | 1 vs 0 |
| less `held` (the same 5 runs) | 67% | 75% | 0 vs 0 |
| less `rests_on_other_runs` (14 / 60) | 82% | 75% | 0 vs 0 |
| less `run_outcome` not completed (1 / 60) | 100% | 100% | 0 vs 0 |

No history run answered wrongly, so no tag had a wrong row to catch: this
measures what filtering costs, not what it saves. `review` and `held` marked the
same runs, and identical input differed by 9 points, which is the noise. Rows they
mark carry "a dismissal was overturned", a warning worth keeping; only
`rests_on_other_runs` is a filter candidate, and it needs poisoned history to show.
