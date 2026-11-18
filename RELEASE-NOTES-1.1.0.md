# Eta IDE 1.1.0 (not published)

Previous version: 0.1.1.

## What is new
- "Lean path" for small tasks (up to 3 source files and 3 test files, tests failing at the start).
  The model writes one plain first draft. Eta runs the tests. If they fail, Eta makes up to 2 repair rounds.
  The result is never worse than the first draft.
- Every file write goes through a safety check (no copied or cut-off code, no broken syntax).
- If the first draft is weak, round 1 is a fresh draft instead of a repair.
- Test differences ("expected / received") are shown to the model in the repair prompt.
- Turn it off with ETA_LEAN=0.

## Measured results (Aider-style small tasks, Python and JavaScript, same model, same PC)
| Version | Passed |
|---|---|
| Old engine (0.1.1), seed 3 | 2 of 10 |
| Lean path, seed 3 | 13 of 20 (second run 9 of 10) |
| Lean path, all runs (seeds 3 and 4) | 34 of 50 (68%) |
| Plain model, one call, same runs | 25 of 50 (50%) |

Runs are noisy: the plain model alone scored from 4/10 to 9/10 on different days.

## How much better than the previous version
- Same 10 tasks (seed 3): previous engine 2 of 10 (20%). Lean path 13 of 20 over two runs (65%). That is about 3 times more tasks solved.
- Lean path against the plain model: 68% against 50%. Better, but with few runs, so treat it as "at least as good", not as a sure gain.
- Honest limit: the 2 of 10 number was measured on the engine just before the lean path (0.1.1 plus later fixes), not on the 0.1.1 installer itself. Seed 4 was not run on the old engine.

## Not proven
- Hard tasks (for example pov, connect) fail for both lean and plain.
- Large projects, tasks without tests, many files, and other languages were not measured.
- On slow PCs a model call can take over 5 minutes.
