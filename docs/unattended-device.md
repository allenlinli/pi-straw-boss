# Setting up an unattended device

An unattended device is a computer nobody sits at (a build box, a server) that other people's computers send work to over Straw Link. Its own infra sets it up: this page is
what that infra has to put where. The design is [the Straw Link spec](specs/2026-10-25-straw-link.md) (Storage and policy, Unattended devices) and
[the sb server spec](specs/2026-10-26-sb-backend.md) (Unattended devices, rebased); what the code does is in [how-it-works](how-it-works.md) (Straw Link).

There is **no boot pi session**. The sb server (`cli.mjs serve`) is the link holder, so two long-lived processes run under one unprivileged user: the Herdr server and the sb server.

## 1. The two processes: systemd user units

Both run under `env -i`, with only `HOME`, `PATH`, `TERM` and `LANG`, and with Herdr on its **default** socket, so the sb server is the primary one (a named `herdr --session` is
invisible to the net, and an environment inherited from a pi session makes every pane's pi act as a subagent). Enable lingering so the units start at boot without a login:
`loginctl enable-linger <user>`.

`~/.config/systemd/user/herdr.service`:

```ini
[Unit]
Description=Herdr server (default socket)

[Service]
ExecStart=/usr/bin/env -i HOME=%h PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 herdr server
Restart=always

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/straw-boss.service`:

```ini
[Unit]
Description=Straw Boss server (the Straw Link holder)
After=herdr.service
Requires=herdr.service

[Service]
ExecStart=/usr/bin/env -i HOME=%h PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 node <pi-straw-boss>/cli.mjs serve
Restart=always

[Install]
WantedBy=default.target
```

`herdr server`, not `herdr`: the second wants a terminal. Install Herdr's pi integration once (`herdr integration install pi`) so Herdr resumes pi panes from their session files. On macOS the
same two commands run as a launchd daemon with `UserName`, with the same environment.

## 2. The policy file

`/etc/straw-link/policy.json` (the path is fixed in `src/link/policy.ts`). It decides that the device is unattended, which controllers it obeys and at what level, and which teams it takes
and where their work happens. **Owned by `root:root`, mode `0644`, in a directory owned by `root` at `0755`**: the check refuses unattended mode unless both the file and its directory
belong to another user than the one the server runs as, neither is a symlink, and neither is writable by that user.

```json
{
  "unattended": true,
  "trust": { "<controller device id>": "dispatch" },
  "teams": { "<team id>": { "project": "/srv/work/moldplan-center", "share": "status" } }
}
```

- A controller set to `true` instead of a level is at `dispatch`. `reply` is the default for anyone not listed.
- `project` is absolute and must pass the same check as `link.teams` (not the home folder, not a pi folder). `share` defaults to `status`.
- `config.json`'s `link` section is **ignored** on an unattended device, relay included: the relay comes from the invite.
- A file that says `unattended: true` but fails the check, or whose `teams` is malformed, **refuses** unattended mode: no holder runs, every sender is at `reply`, the team list is empty.
  The reason is written once to `link/link.log` (`policy-refused`) and shown as a log-line notice of the server.

## 3. Joining: `join.txt`

An unattended device has no screen to paste an invite into. An admin on an attended computer creates an invite pinned to this device's id; the infra drops the text in
`<pi agent dir>/straw-boss/link/join.txt`, **owned by the server's own user, mode `0600`, a regular file** (never a symlink). The device's id is in `link/device.id` (26 characters, a to z
and 2 to 7); it exists from the first look of the server, before any team, so the admin can pin the invite to it.

The holder reads the file at start and on each tick while no join is in flight, asks the relay, waits for an admin's approval, writes the team file (never `config.json`) with project and share from
the policy, and ends with one logged outcome (`joined`, `refused`, `lapsed`, `failed`, `already-member`) after which the file is deleted. An invite for a team the policy does not name, or one that is
not pinned to this device's id, is refused before the relay hears of it. If the relay cannot be reached or answers with a passing failure, the file stays and the device tries again after a wait
(`join-file-retry`, 30 s up to 5 min). A file that cannot be removed (the folder is not writable) is reported once and left alone until it changes. Any failure of the file check deletes the file, so a leaked secret does not stay on disk. A server that restarts in the middle of a join loses the invite: drop a new
one. The invite text is never logged.

## 4. Pre-trusting the projects: `trust.json`

A project folder's `.pi/settings.json` and extensions ask for trust the first time a pi starts in it, and nobody is there to answer. Write the bound projects into pi's own
`<pi agent dir>/trust.json` (`{ "/srv/work/moldplan-center": true }`) when the device is set up. Without it the run fails after ten minutes of an unanswered question, and the controller gets a
`notice` (`trust-unanswered`). `assertSettingsSafe` still applies to every run and refuses a project whose settings link out of it; that refusal is also a `notice` (`run-refused`).

## 5. What a refusal looks like

Everything is in `<pi agent dir>/straw-boss/link/link.log` (JSON lines) and the server's log; texts of dialogs and invites are never in them.

| Log event | Meaning |
| --- | --- |
| `policy-refused` | The policy file failed the owner or write check or is malformed; the reason is in the line. No holder runs. |
| `join-file` with `outcome` | How a `join.txt` ended. `refused` carries the reason (symlink, owner, mode, not a regular file, team not in the policy, invite not pinned). |
| `join-file-retry` | The relay failed for a passing reason; the file stays and the next try is `waitMs` away. |
| `join-file-stuck` | The file could not be removed; reported once for that file. |
| `tower-open-failed` | A controller's message found no tower and the server could not open one; the controller got a `notice`. |
| `dialog-oversize` | A question was too big to forward (64 KB); the controller got a `notice`. |
| `notice` | A notice was sent: `key`, `kind` and unit, never its text. |
| `drop` with `reason` | A message failed a check (`dialog-answer-level`, `dialog-answer-digest`, `dialog-answer-here-only`, `unit-status-unexpected`, …). |

## 6. What a controller sees

Its page shows the device's bases like an ally's, with each unit's state, its running monitors, and its last report (the last `tower_done` summary or the last `tower_send` text to that
controller, cut to 4 KB), sent every minute and on a change. Only the units of workspaces inside the team's project are listed, and none when the team shares `presence` only; a device that has sent
nothing for 3 minutes shows its last units marked "no status lately". A `notice` (1 KB) arrives in the Link bar for: an ally or main run that crashed, timed out or was quit; a forwarded dialog
unanswered for 30 minutes (once); a dialog too big to forward; a tower that could not be opened; a run refused by the settings check or by a trust question nobody answered. Clearing a notice
is local to that page.
