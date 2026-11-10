---
title: Concepts
description: Members, main agents, towers, the head tower, and how they talk.
---

pi-straw-boss gives the agents you run across Herdr tabs a light chain of command.
Joining is automatic; the chain of command is earned.

![Herdr with pi-straw-boss: the sidebar's net view of every workspace, tower, main agent, and subagent, beside a main agent at work](/pi-straw-boss/docs/img/herdr-window.png)

## Roles

| Role | Who | What it does |
| --- | --- | --- |
| **Member** | Every pi in a Herdr tab, from its start | Works on its own. With a main in the tab, it tells the main before it dispatches subagents. |
| **Main agent** | One per tab: the member that promotes first, or you with `/boss` | Plans, dispatches workers, checks their results, and asks you before it merges or deploys. |
| **Tower** | One per workspace, in its own tab pinned first | Coordinates the mains of its workspace and the other towers, and opens a tab with a new main for work no session owns. It never asks you. |
| **Head tower** | One per computer, belonging to no project | Takes your instructions and hands each to the tower of the workspace that owns it. See [The head tower](/pi-straw-boss/docs/guide/head-tower/). |

**Promotion.**
An agent whose work grows (several steps, dispatching workers, more than one app) calls `boss_promote`.
A member that dispatches a subagent is promoted first, automatically.
A tab has one main, and nobody takes it over except you with `/boss`.
A main never demotes; when its session ends, the tab has no main until a member promotes.

**Kinds of main.**
A main runs as a `coordinator` (the default: it plans and dispatches), an `integrator` (a project's [merge trains](/pi-straw-boss/docs/guide/merge-train/)), or `standing` (one system or machine, with no end).
It sets its kind with `boss_duty`, and the page shows it.

**When the tower opens.**
A tower opens in its own tab when agents start to collide: a member dispatches a subagent, an agent promotes itself, a workspace has two members while another workspace already has a tower, or you type `/boss tower`.
Mains and the tower go together: a tower that opens promotes each tab's earliest member, and a tower that quits turns every main back into a member (their subagents stay).

**Subagents.**
Subagents launched with [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents), and sessions in Herdr worktree workspaces, never join the net.
The session that launched them speaks for them, and every view lists them under it.

The full rules are in [Roles and the tower](/pi-straw-boss/docs/reference/how-it-works/how-it-works/).

## Talking

- **`call_tower`**: a main messages its tower at three points only: `milestone` (something landed), `shared` (before it changes something outside its tab, such as a port, a database, a shared branch, or a deploy target), and `blocked` (it waits on someone outside its tab).
- **`tower_list` and `tower_send`**: a tower lists every workspace's tower and writes to one or all of them. A workspace without a tower is reached through its mains, else its members.
- **`boss_broadcast`**: a message to a tab, a workspace, every tower, or every session.
- Every `call_tower`, `boss_broadcast`, and `tower_send` message opens with a header the code writes: who sent it, in what role, to whom, and whether a reply is expected. See [Talking between towers](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#talking-between-towers).

## What a tower knows

- **The work board.** A main's board entry fills itself from its todo list and its name; `board_set` overrides it. Towers read every main's entry with `board_read`, on this computer and on teammates' computers, so a tower routes work knowing where each main stands. Allies see only an automatic entry's name and progress (`<name> (3/5)`), never its task text. See [The work board](/pi-straw-boss/docs/reference/how-it-works/how-it-works/#the-work-board).
- **The digest.** Joins, subagent launches, and renames in its workspace since its last run, read into its next run once and cleared.
- **Its memory.** Your standing instructions, your decisions, and the waits it recorded on you. See [Tower memory](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#tower-memory).
- **The dashboard.** A live view in the tower's tab of who joined and what they and their subagents are doing.

A main a tower opened for a request reports to the sender and to the tower when it is done, and the tower closes it with `boss_close_main` once nothing runs in it.

## The sb server

One background process per computer, the sb server, runs the towers, serves the browser view, and holds the Straw Link connection, so none of them depends on which pi session happens to run.
Any pi session starts it when it is down.
`/boss server` shows it, and `boss_server` lets an agent read its log or restart it with a reason.
See [The sb server](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/).

## Housekeeping

- **Tidy tabs.** When a pi starts in a tab or quits out of it, the tab's panes are made equal again, so workers split off one by one don't leave a chain of halves.
- **Stranded subagents are asked to report.** A subagent that stays open after finishing, while the pi that launched it was restarted, is asked once over intercom to send its final report there.
- **Subagents a Herdr restart brought back as plain pi sessions are resumed.** Straw Boss closes the restored pane and asks the launching session to resume the run with `subagent_resume`. See [Orphaned subagents](/pi-straw-boss/docs/reference/how-it-works/orphaned-subagents/).
- **Stray processes are stopped.** What a worker's shell started is stopped when the worker quits. See [Process hygiene](/pi-straw-boss/docs/guide/process-hygiene/).
