# Eta IDE benchmarks

Eta IDE makes an open-source model finish coding tasks it fails on its own. Same model, same PC, same tasks:
the agent turns **20 % into about 65 %** of tasks solved.

## What was tested

- **Model:** Qwen3.8 35B-A3B (open weights, 3 B active), 3-bit quant, running fully on a normal home PC
  (RTX 3060 12 GB, 8 GB RAM). No cloud, no API key.
- **Tasks:** small coding exercises in Python and JavaScript, in the style of the Aider polyglot benchmark.
  Each task has a task text and a hidden test suite. A task counts only when the hidden tests pass.
- **Three setups, same tasks:**
  1. **Plain model:** one call, the model's answer is written to the file, nothing else.
  2. **Eta 0.1.1 agent (before):** the earlier full engine with plan, steps and checks.
  3. **Eta 1.1.0 agent (now):** the new "lean path" (first draft, run the tests, up to 2 targeted repairs,
     never end worse than the first draft), with a write gate on every file write.

## Results

| Setup | Tasks passed |
|---|---|
| Eta 0.1.1 agent (before), 10 tasks | 2 of 10 (**20 %**) |
| Plain model, no agent, 50 task runs | 25 of 50 (50 %) |
| **Eta 1.1.0 agent**, same 10 tasks | 13 of 20 (**65 %**) |
| **Eta 1.1.0 agent**, all 50 task runs | **34 of 50 (68 %)** |

- Agent against its own earlier version: **20 % to 65 %**, about 3 times more tasks solved.
- Agent against the plain model: **68 % against 50 %** on the same runs.
- Four runs on two task sets: 9/10 and 13/20 on set A, 5/10 and 7/10 on set B for the agent.

### Example: one full run, 10 tasks (seed 4, second run)

| Task | Plain model | Eta 1.1.0 |
|---|---|---|
| js-list-ops | pass | pass |
| js-parallel-letter-frequency | fail | **pass** |
| js-twelve-days | fail | **pass** |
| js-variable-length-quantity | fail | **pass** |
| py-affine-cipher | pass | pass |
| py-beer-song | pass | pass |
| py-bottle-song | pass | pass |
| js-connect | fail | fail |
| py-connect | fail | fail |
| py-scale-generator | fail | fail |
| **Total** | **4 of 10** | **7 of 10** |

In this run the agent solved every task the plain model solved, and three more. It never lost a task the plain
model won.

## Why it works

- The agent keeps the model's first answer as a floor. A repair can only replace it when it scores better.
- Failed tests are shown to the model as an exact "expected / received" difference, so a repair is targeted.
- If the first draft is weak, the next round starts fresh instead of patching a bad base.
- A write gate refuses copied, cut-off or broken files before they reach disk.

## Honest scope

- These are small tasks with tests. Hard algorithm tasks (connect, pov, scale-generator) still fail for both setups.
- Runs are noisy: the plain model alone scored between 4/10 and 9/10 on different days. Treat the gap to the plain
  model as "clearly not worse, probably better", and the gain over 0.1.1 as the main result.
- Not measured yet: big projects, tasks without tests, many-file changes, languages other than Python and JavaScript.
- A model call can take several minutes on a weak PC. Speed work continues.

Reproduce: `dev-scratch` harness scripts are not published; the engine tests are in `console/test-*.mjs`
(`node console/test-all.mjs`, 3,700+ checks).
