---
title: Install
description: Install pi-straw-boss and the packages it needs.
---

```bash
pi install npm:pi-straw-boss
```

The extension does nothing outside [Herdr](https://herdr.dev).
Subagents and sessions in Herdr worktree workspaces never join the net: the session that launched them speaks for them.

## Requirements

- **pi inside Herdr 0.9.4 or newer.**
- **Herdr's pi integration**, `herdr integration install pi`. Without it Herdr does not name a pane's pi session, and the session cannot join the net. Each session warns once, 20 s after its start, when the integration is missing.
- **[pi-intercom](https://www.npmjs.com/package/pi-intercom) 0.18.1 or newer.** The net's channels and messages, the GUI's dialog relay, and the sb server's connection run over it. The server checks the version at start and reports an older or missing pi-intercom in `start-error.json` and in `boss_server status`.
- **[pi-anchorloop](https://www.npmjs.com/package/pi-anchorloop) 2.11.0 or newer**, only for the [merge train](/pi-straw-boss/docs/guide/merge-train/). Its `integrating` and `deploying` skills are the train's procedure. Without it, a main or integrator that meets a car slip reports `blocked` naming pi-anchorloop and merges nothing.

Windows support is experimental.
The extension reaches Herdr over its named pipe there, the sidebar plugin runs with the `node` on `PATH`, the worktree reaper runs on macOS and Linux only, and the project-trust relay works only while pi's agent folder lies inside your user profile.
See [Windows](/pi-straw-boss/docs/reference/how-it-works/windows/) for the rest.

## Works with

Each of these is optional.
When one is installed, Straw Boss picks it up; without it, the rest works as before.

| Package | What Straw Boss does with it |
| --- | --- |
| [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) | Subagents show under the session that launched them, in the tower dashboard, the sidebar, and the GUI. A member that dispatches one is promoted to main, and its tower opens. |
| [@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) 2.13 or newer | `ask_user_question` questionnaires can be answered or cancelled from the GUI, and a waiting one marks its unit as waiting. |
| [pi-robot-hand](https://www.npmjs.com/package/pi-robot-hand) 0.3.0 or newer | `robot_hand` selectors can be answered from the GUI. |
| pi-code (hooks extension, with its dialog events) | Its hook confirmation ("Allow bash?") can be answered from the GUI. |
| [pi-herdr-doc-review](https://www.npmjs.com/package/pi-herdr-doc-review) 0.4.0 or newer | Documents a session shows open beside its comms: HTML in a sandboxed frame whose form answers the agent, text read-only. |
| [@juicesharp/rpiv-todo](https://www.npmjs.com/package/@juicesharp/rpiv-todo) 2.13 or newer | A session's todo list shows above its composer in the GUI, read from the session file. |

Any extension's `select` and `confirm` can be answered from the GUI too, with no change to that extension.
Straw Boss wraps them on pi's shared `ctx.ui`, opens pi's own dialog as always, and relays the same dialog; the first answer wins.
`input`, `editor`, and `custom` dialogs are never touched: they show read-only in the GUI, with the terminal one tap away.

## Optional Herdr plugins

Two Herdr plugins ship in the repository: a net view for Herdr's sidebar and a reaper for the panes and checkouts agents leave in worktree workspaces.
See [Herdr plugins](/pi-straw-boss/docs/guide/herdr-plugins/).
