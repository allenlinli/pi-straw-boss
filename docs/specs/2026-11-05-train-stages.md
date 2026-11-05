# Train stages: merge, deploy, UAT (phase 1b)

Status: prompt-only, on `feat/train-stages`. Extends [the merge train](2026-10-30-merge-train.md); its phase 2 (code) is still not built.

## Why

The merge train took format, lint, build and full suites off each coordinator. Deploys and UAT stayed with each coordinator, and broke the same way merges had before the train:

- An older pipeline that queued longer deployed after a newer one and rolled a target back to the older version.
- A merge was gated on a monitor finishing, not on the run's conclusion; the run had failed.
- A rollout counted an image pull of 5.5 minutes against its health deadline and reverted a healthy release.
- Each coordinator opened its own review page for the boss at its own time, with captures taken on a dev server before merge, not on the integrated result that ships.

## Decisions (boss form, 2026-11-05)

| # | Decision |
|---|---|
| D1 | One integrator per project carries a train through all its stages; no separate deploy or UAT main. Its name stays `integ <project>`. |
| D2 | A deploy target may be any target, a live one included, as long as the slip's `auth` quotes the boss's words for that target, or the config marks it `auto` (D2b). |
| D2b | (Boss, 2026-11-05, after review) Config decides per target whether a train deploys there automatically: `integration.targets` maps a target to `auto` (every train, no per-car authorization; the config is the boss's standing word, so only the boss sets it; a test environment usually is) or `strict` (default: only cars whose `auth` names it; else the integrator asks the boss). |
| D3 | Straw Boss states the flow only and names no environment (no "staging" or "production"; a test guards it). UAT judges the train's deployed result; where and how it is captured, and by whom, is the project skill's `UAT`. Extra gates for a live target (such as a confirmation per target) live in the project skill's `Deploy`. |
| D4 | The UAT page opens as soon as it is ready; it does not wait for the boss's presence. |
| D5 | (Project-side, moldplan-center) a ticket with a `human` anchor is closed only after UAT accepts it. In Straw Boss terms: a `uat` car is reported to its coordinator only after acceptance. |
| D6 | Prompts first, as phase 1 was; moldplan-center pilots it; code comes after the pilot. |

## Contract

- `apps.json` per-app `integration.targets`: target to `auto` or `strict` (D2b).
- `apps.json` per-app `integration.stages`: an ordered list, `merge` (default, always first), then optionally `deploy`, then `uat` (only after `deploy`).
- New skill headings: `## Deploy` and `## Deploy verify` (stage `deploy`), `## UAT` (stage `uat`, read by the coordinator too). A declared stage without its headings stops departure with `why=blocked`, as a missing required heading does.
- The car slip gains one line: `deploy: <targets or none> | uat: <checkpoints path or none>`. `auth` must cover the integration branch and every `strict` target the slip names; `auto` targets need no per-car words. A checkpoints file lists per checkpoint its flow, state, steps, and expected result.

## Flow

1. Merge stage: unchanged (`Train assembly`, train review, `Full gates`, `Merge`, `Post-merge`).
2. Deploy stage: `Deploy` per target in the skill's order: every `auto` target, and the `strict` targets the slips name. A `strict` target takes the train only when every car in it has `auth` naming it, since a deploy ships every car (review RV-F001). Otherwise the integrator asks the boss whether to deploy that target or hold the cars it does not cover (a held car is not landed); where merging deploys the target, it asks before `Merge` (boss, 2026-11-05: this question is the boss's). One train at a time per target; where merging deploys a target, the next train's `Merge` waits for this train's `Deploy verify` on it. A deploy the integrator starts itself, not one its merge triggers, still calls `shared` naming the target so the tower can check for a clash. `Deploy verify` per target. Done is the target running the train's own version; a green job, an accepted request, or a finished monitor is not done. A failed target is rolled back as the skill says and its car goes back as a red car does.
3. UAT stage: `UAT` captures every checkpoint of the train's `uat` cars on the deployed result; one page with one `review` block per train, opened at once. A later train may deploy meanwhile; the captures are the record. A comment returns the car with comments, captures, and version; `UAT` says whether it is reverted first; a revert on the base goes as its own train through review, gates, merge and deploy; the fix returns as a new car and its commented checkpoints are captured again, or all of them after a revert. A `uat` car must name a `deploy` target.
4. A car with no stage left is reported landed (a `uat` car: also accepted in UAT); its coordinator closes the ticket. The integrator reports idle only when no stage runs and no UAT page waits.

## Prompt changes

| File | Change |
|---|---|
| `prompts/integrator.md` | Stages, slip line, Deploy and UAT sections, ledger fields, idle condition; the urgent lane names a P0 defect in a live target instead of a production fix (D3). Budget 600 to 1000 words; it is read on demand, not in the system prompt. |
| `prompts/apps-config.md` | `stages` and `targets` fields and the three headings; an `auto` entry is added or widened only with the boss's words quoted in the commit message. |
| `prompts/tower-run.md` | The integrator's own `shared` request: a deploy it starts names its target, and the tower checks that target for a clash. |
| `prompts/planning.md` | A `human` anchor in a `uat` app is the train's UAT: the slip names its checkpoints file. Budget unchanged (670): the gate list and two clauses were cut. |

`main.md` and `tower.md` are unchanged: the slip still travels as `why=shared` and goes to the one integrator.
