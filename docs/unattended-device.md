# Setting up an unattended device

English | [繁體中文](unattended-device.zh-TW.md)

An unattended device is a computer nobody sits at (a build box, a server) that other people's computers send work to over Straw Link. Its own infra sets it up: this page is
what that infra has to put where. The design is [the Straw Link spec](specs/2026-10-25-straw-link.md) (Storage and policy, Unattended devices) and
[the sb server spec](specs/2026-10-26-sb-backend.md) (Unattended devices, rebased); what the code does is in [how-it-works](how-it-works.md) (Straw Link).

Two computers take part. The device is set up by its infra (sections 1, 2, 4 and 5). A controller, an attended computer of the team's admin, creates the team and the invite and approves the join (section 3).

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

## 3. The controller's side: the team, the invite, the approval

This is done in the GUI of an attended computer; the approval can also be done in pi. Nothing here touches the device.

1. **Turn Straw Link on.** Settings → Teams shows "Set up Straw Link" while Straw Link is not running on that computer. Press it and wait a few seconds; it also writes `link/enabled`.
2. **Create the team** (once per team; skip it when the team exists). The relay's operator gives you a one-time team token. Open "Create a team", fill the Relay URL, the Team token, "This computer's label", "Share" (your towers' and tabs' states, or only that you are online) and the Project folder, then press "Create team". The token field is a password field, so a password manager's inline menu can take the focus when you click it: close the menu before you paste. The page clears the token once it is used.
3. **Read the two ids the device's policy needs** (section 2). The controller's device id is in the header of the Teams page ("device id …") and in its `<pi agent dir>/straw-boss/link/device.id`. The team's id is 32 hex digits: the page shows only the first six, and the team's file `<pi agent dir>/straw-boss/link/teams/<team id>.json` carries all of it in its name.
4. **Invite the device.** The infra reads the device's id from `link/device.id` on the device (26 characters) and gives it to you. On the team's card press "Invite an unattended device", type the id into the field "26-character device id", and press "Invite". The page shows the invite as a QR code and as text, with the time it lapses in; press "Copy". An invite pinned to a device lapses after just under 24 hours (an ordinary invite after 10 minutes) and works once.
5. **Give the text to the infra**, who drops it in `join.txt` on the device (section 4).
6. **Approve the join.** When the device's holder asks the relay, a card "{label} ({short}), an unattended device, asks to join team {team}" appears under Teams, and the Link bar raises a notice with a "Review" button. There are no four words to match: the device id in your invite stands in. Press "Approve" (or "Refuse"). In pi, `/boss link` lists the waiting requests with a short id and `/boss link decide <id> approve|refuse` decides; pi asks you to confirm an unattended device first, and a paired phone can read the requests but not decide them.
7. **Check.** The device is in the team's roster, with "unattended" in the column Kind. Its trust for your messages is the policy file's, not the roster's: your controller device id has to be in the policy's `trust` at `dispatch` (section 2).

## 4. Joining: `join.txt`

An unattended device has no screen to paste an invite into. An admin on an attended computer creates an invite pinned to this device's id; the infra drops the text in
`<pi agent dir>/straw-boss/link/join.txt`, **owned by the server's own user, mode `0600`, a regular file** (never a symlink). The device's id is in `link/device.id` (26 characters, a to z
and 2 to 7); it exists from the first look of the server, before any team, so the admin can pin the invite to it.

The holder reads the file at start and on each tick while no join is in flight, asks the relay, waits for an admin's approval, writes the team file (never `config.json`) with project and share from
the policy, and ends with one logged outcome (`joined`, `refused`, `lapsed`, `failed`, `already-member`) after which the file is deleted. An invite for a team the policy does not name, or one that is
not pinned to this device's id, is refused before the relay hears of it. If the relay cannot be reached or answers with a passing failure, the file stays and the device tries again after a wait
(`join-file-retry`, 30 s up to 5 min). A file that cannot be removed (the folder is not writable) is reported once and left alone until it changes. Any failure of the file check deletes the file, so a leaked secret does not stay on disk. A server that restarts in the middle of a join loses the invite: drop a new
one. The invite text is never logged.

## 5. Pre-trusting the projects: `trust.json`

A project folder's `.pi/settings.json` and extensions ask for trust the first time a pi starts in it, and so does a `.agents/skills` folder in the working directory or any folder above it. Nobody is there to answer. Write the bound projects into pi's own
`<pi agent dir>/trust.json` (`{ "/srv/work/moldplan-center": true }`) when the device is set up. Without it the run fails after ten minutes of an unanswered question, and the controller gets a
`notice` (`trust-unanswered`). `assertSettingsSafe` still applies to every run and refuses a project whose settings link out of it; that refusal is also a `notice` (`run-refused`).

The project is not the only folder a pi starts in:

- **Herdr's worker worktrees.** When a tower opens a worker, Herdr opens a worktree for it at `~/.herdr/worktrees/<repo>/<branch>` (seen on macOS; the Linux path is not confirmed yet, so check it at the first trial with a real worker), outside the project. A repository that carries `.agents/skills` stops every such worker at the trust prompt. pi uses the nearest entry of `trust.json` at or above the working directory, so one entry for the worktrees folder (`"/home/<user>/.herdr/worktrees": true`, written as its real path) covers every worktree, and one entry for the work folder (`"/srv/work": true`) covers every repository under it. Create the worktrees folder first, so that its real path can be written.
- **A changed `HOME`.** pi treats only `$HOME/.agents/skills` (the `HOME` of the pi process) as the user's own. A process that sets another `HOME` and then starts an interactive pi in a folder under the real home (for example `~/.pi/agent/sessions`) no longer has `~/.agents/skills` exempt and gets the trust prompt. Start such a pi with the real `HOME`, or trust that folder.

## 6. What a refusal looks like

Everything is in `<pi agent dir>/straw-boss/link/link.log` (JSON lines) and the server's log; texts of dialogs and invites are never in them.

| Log event | Meaning |
| --- | --- |
| `policy-refused` | The policy file failed the owner or write check or is malformed; the reason is in the line. No holder runs. |
| `join-file` with `outcome` | How a `join.txt` ended. `refused` carries the reason (symlink, owner, mode, not a regular file, team not in the policy, invite not pinned). |
| `join-file-retry` | The relay failed for a passing reason; the file stays and the next try is `waitMs` away. |
| `join-file-stuck` | The file could not be removed; reported once for that file. |
| `tower-open-failed` | A controller's message found no tower and the server could not open one; the controller got a `notice`. |
| `tower-in` | A `tower` or `tower-reply` message was kept in the inbox: `from` (the sender's device id), `team`, `ask` (the ask id it carries, when it has one), `id` (the message id). |
| `tower-run` | An ally run took that message into its session: `run` (the run id), and the same `from`, `team`, `ask`, `id`. |
| `dialog-oversize` | A question was too big to forward (64 KB); the controller got a `notice`. |
| `notice` | A notice was sent: `key`, `kind` and unit, never its text. |
| `drop` with `reason` | A message failed a check (`dialog-answer-level`, `dialog-answer-digest`, `dialog-answer-here-only`, `dialog-answer-not-recipient`, `unit-status-unexpected`, …). |

## 7. What a controller sees

**On a box several devs share, a controller sees only its own work and the admins see all of it.** A question a unit asks and a run's notice go to the controller that dispatched the unit (the device whose message started the ally run, or for which the run opened the main) and to the team's admins, not to the other controllers at `dispatch`; a unit nobody dispatched (the tower's own run) is the admins' alone. The box refuses an answer to a question from anyone else (`drop` with `dialog-answer-not-recipient`). The policy file has no field for this.

Its page shows the device's bases like an ally's, with each unit's state, its running monitors, and its last report (the last `tower_done` summary or the last `tower_send` text to that
controller, cut to 4 KB), sent every minute and on a change. Only the units of workspaces inside the team's project are listed, and none when the team shares `presence` only; a device that has sent
nothing for 3 minutes shows its last units marked "no status lately". A `notice` (1 KB) arrives in the Link bar for: an ally or main run that crashed, timed out or was quit; a forwarded dialog
unanswered for 30 minutes (once); a dialog too big to forward; a tower that could not be opened; a run refused by the settings check or by a trust question nobody answered. Clearing a notice
is local to that page.
