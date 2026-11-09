## Dispatch
- Split work by owning app ({{dir}}/apps-config.md). A task is one worker's end-to-end work in one app; parallel writers get worktrees; dependent tasks wait. A hand-made worktree goes under `~/.herdr/worktrees/<repo>/<branch>`: elsewhere a child hangs on pi's trust prompt.
- When a result passes its brief and anchor, mark its todo `completed` and dispatch what it unblocked. A failed or cancelled task leaves its dependents blocked: report them, and resolve the next step with the boss.
