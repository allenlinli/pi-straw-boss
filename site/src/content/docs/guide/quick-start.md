---
title: Quick start
description: See the net work in four steps.
---

1. **Open pi in a Herdr tab and give it work.** It joins the net by itself. When its work grows, it promotes itself to the tab's main agent, which also opens the workspace's tower. Type `/boss` to take over as the tab's main yourself.
2. **Type `/boss status`** to see each tab's main agent and the towers.
3. **Type `/boss tower`** to open the workspace's tower and watch its dashboard. It also opens by itself when agents start to collide. You do not need to talk to it.
4. **Type `/boss gui`** from any session to see the whole net in your browser.

![The tower's dashboard in the terminal: this net's tabs, agents, and subagents, and the other towers](/pi-straw-boss/docs/img/tower-dashboard.png)

## The tower runs on its own

The tower service of the sb server is on by default.
A tower is a run that wakes for the events it gets and ends with a handoff note; `/boss tower <prompt>` writes to it.
A teammate's [Straw Link](/pi-straw-boss/docs/guide/straw-link/) message gets an ally run of its own.

Each run starts fresh.
What has to outlive a run sits in a small memory: your standing instructions, your decisions, and the tower's open waits on you.
Read and change it with `/boss memory`, or in the tower's comms in the GUI.
A tower can only propose a standing instruction or a decision; it takes effect when you confirm it.
See [Tower memory](/pi-straw-boss/docs/reference/how-it-works/the-sb-server/#tower-memory).

The tower only routes and coordinates, so it can run a lighter model: set `towerModel` in the [configuration](/pi-straw-boss/docs/reference/configuration/).

## Next

- [Concepts](/pi-straw-boss/docs/guide/concepts/): who is a member, a main, a tower, and the head tower.
- [The browser view](/pi-straw-boss/docs/guide/browser-view/): the map, comms, alerts, and the Zen view.
- [Commands](/pi-straw-boss/docs/reference/commands/): every tool and `/boss` command.
