# Seam bindings: the merge train's procedure moves to pi-anchorloop

Status: implemented on `feat/seam-bindings` (from `47b91ba`), for 0.60.0, not released. Source: pi-anchorloop 2.10.0 (`skills/integrating`, `skills/deploying`, `references/seams.md`; its design record `docs/specs/2026-11-06-integrating-deploying/design.md` holds the host-side follow-up this implements).

## Decisions (boss, 2026-11-06)

- Two skills, `integrating` and `deploying`, hold the generic train procedure.
- anchorloop names only generic seams; Straw Boss's session prompt binds them ("sb's session prompt binds the seams").
- With the train off, the bindings drop out through the existing `<!-- integration -->` markers (`src/trainswitch.ts`) and anchorloop's defaults apply: the session asks the boss before a merge or a deploy.
- The README states that pi-anchorloop is required (2.10.0 or newer).

## Where the block lives

anchorloop reads one `## Seam bindings` block from the session's instructions (a project may hold one more; the session's line wins per seam) and says each of the two holds "at most one". The sessions that run the skills are mains: every coordinator, and the integrator. The tower runs no skill.

| Session | Needs | Reads |
|---|---|---|
| Coordinator (any main) | Handoff route (where the slip goes), Approval (who gives `auth`, how it asks), Escalation route (`blocked`), Settings (`apps.json`) | `main.md` (system prompt) |
| Integrator (a main) | All six | `main.md` (system prompt), then `integrator.md` for the role |
| Tower | Forwarding of the slip and opening and closing the integrator, which the tower does without a skill | `tower.md`, `tower-run.md` |

Decision: **one block, in `main.md`, as its last text, inside the integration markers.**

- `main.md` is the system prompt of every main, so the block is in front of a coordinator and of the integrator before the first step, with no file to read; the skills' "read the block before the first step" holds.
- The integrator is also a main. A second block in `integrator.md` (or in `planning.md`, which a coordinator reads) would give the integrator two blocks and a coordinator a different one, against the skills' "at most one"; so each role's details go beside the rule that uses them (`integrator.md`: name, ledger, tower calls; `planning.md`: the coordinator's anchor; `tower.md`: forwarding) and refer to the block, not repeat it.
- It is last because the heading `## Seam bindings` runs to the end of what follows it, and `main.md`'s always-on bullets must not read as seam lines. A test pins six lines directly before the closing marker.
- The tower holds no block: it is a separate session, binds nothing, and loads no skill. Its prompts keep the forwarding rule and now say the integrator answers the coordinator itself.
- `integrator.md` is read raw (the file) and is absent from the off copy; the block, in the system prompt, is stripped by `promptSet` when off. One more reason not to put it in a file the copy handles.

## The binding

Each line of the block, and the Straw Boss mechanism it names:

| Seam | Binding in `main.md` | Existing mechanism |
|---|---|---|
| Handoff route | The coordinator sends the slip with `call_tower` `why: shared`; the tower forwards it as it came to the project's one integrator; the integrator answers the slip's `coordinator` by intercom (train number, returned car, landed notice). | `tower.md`, `tower-run.md`; the intercom answer was the integrator's. |
| Batch owner | The project's one integrator main, opened by the tower with `boss_open_main`, renamed `integ <project>` once, closed by the tower after its idle `milestone`; train worktrees `~/.herdr/worktrees/<repo>/train-<code>`. | Old integrator prompt lines 9, 28, 44; the worktree root is the one `main.md` already names. |
| Approval | The boss; the coordinator quotes the boss's covering words in `auth` (brief or messages) and asks with its question tool only when they are missing, in one round naming the base, `pre-dev/<code>`, and every `strict` target; the integrator asks the same for a `strict` target that not every car's `auth` names (review SB-F001, SB-F003); `auto` or `strict` per `integration.targets`. | Old lines 7, 36. |
| Record | `{{state}}/trains/<project>/<app>.json`. | Old line 9 and `main.md`'s "ledgers in {{state}}/trains". anchorloop's default is `<app>.json`; the project folder stays, since several projects share one state folder. |
| Escalation route | `call_tower`: `why=blocked`; idle as `why=milestone`, reply false; a deploy the integrator starts itself as `why=shared` naming the target. | Old lines 8, 30, 44. |
| Settings | `apps.json` `integration`: `base`, `skill`, `stages`, `targets`, `maxCars`, `maxWaitMin`. | `apps-config.md`. |

If a binding's mechanism cannot be reached (the tower is gone, no question tool), anchorloop's rule applies: report it through the Escalation route and keep the stage closed.

## Mapping: old `prompts/integrator.md` (at `47b91ba`, 44 lines) to its home

`I` = `integrating` skill, `Dp` = `deploying` skill, `S` = `references/seams.md`, `R` = `playbooks/receive-car.md`, `T` = `playbooks/train.md`, `U` = `playbooks/urgent-car.md`, `Dep` = `Dp/playbooks/deploy.md`, `Rb` = `Dp/playbooks/rollback.md`. "Here" is the new `integrator.md`; "block" is `main.md`'s Seam bindings.

| Old line | Content | New home |
|---|---|---|
| 3 | One integrator main takes the coordinators' cars for each `integration` app, through `stages` in order | Here (opening), `I` Stages |
| 3 | A main, not the tower | Here |
| 3 | The project skill (`integration.skill`) holds every concrete check, found by headings; add nothing it does not say | Here (first bullet), `I` Project skill contract |
| 3 | The list of headings read | `I` Project skill contract (all ten) |
| 3 | A missing `Light checks`, `Full gates`, `Merge`, or declared stage heading: do not depart, `blocked` naming the config error | `I` Project skill contract (closing paragraph), `S` Binding; here (`blocked` bullet) |
| 7 | No merge without a quote of an authorization covering the integration branch | `I` Rules 1, `R` steps 1 and 2 |
| 7 | `auto` and `strict` targets, unlisted `strict`, `auto` is the boss's standing word | `I` Rules 1, `S` Settings keys; block (Approval) |
| 8 | Only the integrator merges and claims `pre-dev/<code>` | `I` Rules 2 |
| 8 | Own merges, pushes, and merge-triggered deploys need no `shared` call | Here (kept: Straw Boss's tower rule), `I` Rules 2 |
| 8 | A deploy it starts itself calls `shared` naming the target | Here, block (Escalation route), `Dep` step 4 |
| 9 | `boss_rename` to `integ <project>`, 16 characters at most, never again | Here (kept), block (Batch owner) |
| 9 | Ledger at `<project>/<app>.json` in the `trains` folder (car, tickets, SHAs, stage, deployed versions, UAT verdicts) | Here (kept path), block (Record), `S` Ledger |
| 9 | One todo per train | Here, `I` Rules 3 |
| 13 | A slip is one block; one missing field returns it | `R` step 1 |
| 15-21 | The slip block | `R` step 1 (same fields; `coordinator: <who answers for the car>`) |
| 23 | Check `head`, `auth`, `review` (or fix-forward), `uat` file with target, no applied migration; else return the car | `R` step 2 |
| 23 | Answer the coordinator with the train number and departure conditions | `R` step 3; here (the coordinator is a session id, answered by intercom), block (Handoff route) |
| 27 | Depart at `maxCars` 4, `maxWaitMin` 60, or all awaited coordinators; `Load`; branch pipeline not red, fix-forward excepted | `T` step 1, `S` Settings keys |
| 28 | Assemble `train/<code>` from the latest base in `~/.herdr/worktrees/<repo>/train-<code>`; `merge --no-ff` in arrival order; plain conflicts logged; semantic ones back to the later car; `Train assembly` | `T` step 2; block (Batch owner) for the worktree |
| 29 | Fresh-context `reviewer` for interactions, conflict resolutions, migration order; P0 or P1 back to the car or fixed by the integrator; `Full gates` once per train; green then `Merge`, `Post-merge`; push `pre-dev/<code>` only after green; nothing force pushed | `T` opening line and steps 3 and 4; here (the `reviewer` role) |
| 30 | Red: guilty car per `Full gates`, drop and rebuild; head change re-runs `Train assembly`, delta recheck, `Full gates`; after a revert before `Merge`; tell the coordinator car, tests, log path, `train` SHA; session gone: `blocked` | `T` steps 5 and 6; here (`blocked` bullet), block (Escalation route) |
| 31 | `urgent` only on the boss's "first", a P0 defect in a live target, or a fix-forward car; still reviewed and gated | `U` step 1 and opening line |
| 32 | Fix-forward car: only the fix of the latest red pipeline (checked, else returned); `review` may read `author's read`; departs alone as the next train; a running gate interrupted only if `Urgent lane` says so; first review full-depth and checks the car holds only the fix; each new SHA fully reviewed until one passes; other report-less cars returned | `U` steps 2 to 4, `R` steps 1 and 2, `T` step 1 |
| 36 | Deploy: `Deploy` per `auto` target and slip-named target in the skill's order | `Dep` step 1 |
| 36 | A `strict` target needs `auth` on every car; else skip, ask the boss, a held car is not landed, held before `Merge` leaves like a dropped car; ask before `Merge` where merging deploys | `Dep` step 2; block (Approval: the question tool) |
| 36 | One train per target; the next `Merge` waits where merging deploys | `Dep` step 3 |
| 36 | Prepare per target, then `Deploy verify`; done is the train's own version; green job, accepted request, finished monitor is not done | `Dep` steps 5 and 7 |
| 36 | A failed target follows the skill's `Deploy` (rollback, retry); the car goes back as a red one | `Rb` steps 2 and 4 |
| 40 | UAT after `Deploy verify` for cars with a `uat` file, on the deployed result | `Dp` UAT stage lead |
| 40 | One page per train, one `review` block, `label` `<ticket>: <flow>, <state>`, `body` steps and result; opened with `show_doc` `view: "page"` once ready; blank box is accepted | `Dp` UAT stage bullet 2, `human-feedback` uat playbook step 4; here (`show_doc`) |
| 40 | A later train may deploy meanwhile; captures are the record | `Dp` UAT stage bullet 3 |
| 40 | A comment returns the car with comments, captures, version; `UAT` says whether to revert first; a revert goes as its own train; the fix recaptures commented (or all) checkpoints | `Dp` UAT stage bullet 4, `Rb` step 5 |
| 44 | "landed in <version>, your commit is <sha>", plus "accepted in UAT"; the coordinator closes its ticket (the integrator only if its session is gone) | `I` After the train; here (the intercom wording), block (Handoff route) |
| 44 | Idle: `call_tower` `why=milestone`, reply false, saying idle; the tower closes the integrator | Here, block (Escalation route and Batch owner), `I` After the train |

Nothing in the old file is without a home. What the skills leave to the host and `integrator.md` keeps: the role (a main, not the tower), the name, the ledger path and its todo, the "no `shared` call for own merges" tower rule, the `reviewer` role, the `show_doc` page, the session-id form of `coordinator`, and the `blocked` and idle calls.

### `apps-config.md`, `planning.md`, `main.md`, `tower.md`, `tower-run.md`

| Old text | New home |
|---|---|
| `apps-config.md` Merge train principle paragraph | `I` Principle |
| `apps-config.md` heading table (ten headings, readers, contents) | `I` Project skill contract; `apps-config.md` says "see `integrating`'s Project skill contract" (heading names unchanged) |
| `apps-config.md` "Light checks, Full gates, Merge, and each heading of a declared stage are required; else `blocked`" | `I` Project skill contract; `apps-config.md` keeps the `blocked` call |
| `apps-config.md` field rows for `integration` (`skill`, `maxCars`, `maxWaitMin`, `base`, `stages`, `targets`) and the `auto` rule | Kept, `S` Settings keys |
| `apps-config.md` switch paragraph | Kept |
| `planning.md` integration block (coordinator's anchor, gates once on the integrated head, exceptions, `human` anchor is the train's UAT, the train replaces the merge-time checkpoint) | Shortened to a pointer to `I` Principle, which holds the same text and the exceptions; the coordinator-only clauses stay |
| `main.md` "never merge to its base ... unless you are the integrator; send the slip by `call_tower` `why: shared`; rework a returned car" | Kept; the how of the send is now the block |
| `tower.md`, `tower-run.md` forwarding | Kept; added: the integrator answers the coordinator, so the tower relays nothing back |

## Tests

- `tests/prompts.test.ts`: word budgets per switch state (`main.md` on 680, off 500; `tower.md` on 390; `integrator.md` 320); the merge-train tests assert the terms that are still Straw Boss's and that the procedure text is gone from `integrator.md`; a new test checks one `## Seam bindings` heading in `main.md`, one line per seam in the order of `seams.md` with its mechanism, the block directly before the closing marker, none in the other prompts, and nothing left with the train off.
- `tests/trainswitch.test.ts`: a main gets all six bindings with the train on (the ledger path takes the state folder) and none with it off.
- Word counts: `main.md` 500 to 677 on (481 off, unchanged); `integrator.md` 1186 to 289; `planning.md` 669 to 663; `tower.md` 380 to 390 on.

## Not changed

`src/` (the markers and the switch need nothing new), anchorloop, basic-agent, moldplan-center. The moldplan-center project skill's one-line pointer (design follow-up 4) is that project's.
