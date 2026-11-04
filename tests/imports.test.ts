import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import strawBoss, { createStrawBoss } from "../src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// Pi reloads extension TypeScript on /reload, but Node caches native .js/.mjs modules for the
// life of the process. A relative JavaScript import would keep an old version after an upgrade.
test("extension code imports relative modules only as .ts", () => {
	for (const name of readdirSync(join(root, "src/agent")).filter((file) => file.endsWith(".ts"))) {
		for (const [, specifier] of readFileSync(join(root, "src/agent", name), "utf8").matchAll(/from\s+["'](\.\.\/(?:host|gui|dialogs|bridge|handover|mirror|control)\.ts)["']/g)) assert.fail(`src/agent/${name} imports ${specifier}: a net sidecar never hosts or reaches the GUI`);
	}
	for (const dir of ["src", "src/agent", "src/trust", "src/lan"]) {
		for (const name of readdirSync(join(root, dir)).filter((file) => file.endsWith(".ts"))) {
			for (const [, specifier] of readFileSync(join(root, dir, name), "utf8").matchAll(/from\s+["'](\.[^"']*)["']/g)) {
				// The one plain-JavaScript module the extension loads: exe.mjs finds programs by absolute path, and balance.mjs, which Node runs from node_modules where it will not strip types, needs it too.
				if (/(^|\/)exe\.mjs$/.test(specifier ?? "")) continue;
				assert.match(specifier ?? "", /\.ts$/, `${dir}/${name} imports ${specifier}`);
			}
		}
	}
});

test("the module loads, its factory runs, and outside Herdr it registers nothing", () => {
	assert.equal(typeof strawBoss, "function");
	const registered: string[] = [];
	const pi = { on: (type: string) => registered.push(type), registerTool: () => registered.push("tool"), registerCommand: () => registered.push("command") };
	createStrawBoss({ env: {} })(pi as never);
	assert.deepEqual(registered, []);
});

test("the manifest ships only src, the built GUI and server bundles, prompts, README, NOTICE (the QR encoder's MIT notice), and LICENSE, has tsx as its only runtime dependency, builds the bundles before packing and the page before testing, and points at a real entry", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.files, ["src", "dist/gui", "dist/server", "prompts", "README.md", "NOTICE.md", "LICENSE"]);
	assert.deepEqual(Object.keys(manifest.dependencies), ["tsx"], "tsx is the one runtime dependency: the server loads pi-intercom's TypeScript client through it (docs/specs/2026-10-26-sb-backend.md, Process model)");
	assert.ok(manifest.devDependencies.vite, "the page is built with Vite, as a development dependency only");
	assert.equal(manifest.scripts.prepack, "npm run gui:build && npm run build:server");
	assert.equal(manifest.scripts.pretest, "npm run gui:build");
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
	for (const entry of manifest.pi.extensions) assert.ok(existsSync(join(root, entry)), entry);
});

test("the TypeScript source stays within its size budgets", () => {
	const count = (path: string) => readFileSync(join(root, path), "utf8").trimEnd().split("\n").length;
	const names = (dir: string) => readdirSync(join(root, dir)).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
	const sum = (dir: string, list: string[]) => list.reduce((total, name) => total + count(`${dir}/${name}`), 0);
	// The dashboard, the browser view's server and data code, and the session reader each have a budget of their own so the coordination code stays readable on its own.
	// 0.27.0 to 275: what a tick re-reads for every child is cached (the pane that runs each child, indexed once per pane list; the two directories pi-herdr-agents keeps; a launch script's session file),
	// and the screen reads on Herdr's events (watch, debounced) with a 30 s safety poll, and reads again what was requested inside the minimum gap or while a read ran, instead of dropping it.
	// 0.27.0 to 277: the gap is checked again when a pending read fires, and a listing remembers when it was read.
	// Unreleased to 286: `commanding`, the mark of a session that is idle while a subagent of it works or waits (or a monitor runs), and the rows built with it.
	// Unreleased (dashboard split) to 162 and 137: the pi-tui rendering and the widget stay in dashboard.ts (162), the marks, rows, and subagent reading the server loads came out into netdata.ts (137).
	assert.ok(count("src/dashboard.ts") <= 177, `src/dashboard.ts has ${count("src/dashboard.ts")} lines`);
	// Unreleased to 138: a subagent that recorded done is `done` even while its pi pane still says working (one line more).
	assert.ok(count("src/netdata.ts") <= 138, `src/netdata.ts has ${count("src/netdata.ts")} lines`);
	// 0.5.0 raised the server's figure from 300 to 320 for the CSRF meta, the POST routing into control.ts, and the remote access check (pairing, remote streams);
	// 0.6.0 to 325 for the hub's start and stop with the server, the answer route's fresh reading, gui.json's ownerSession, and the sessions a reading binds dialogs with;
	// 0.7.0 to 330 for the terminal mirror (Phase 3 task 1): each stream's `hello` with its id, and the mirrors it holds created, closed with it, and stopped with the server.
	// 0.8.0 to the Phase 3 plan's 335 for documents: a unit's documents in the snapshot (task 6), the document routes' dispatch and the app's frame-src (task 7).
	// 0.10.1 to 336 for the bundle read whole at start, so a package update under a running server leaves its page's assets in place.
	// 0.11.0 to 377 for any session reaching the one server: the stop request and its wait (requestStop), the takeover in sharedGui, the version
	// and reload mark gui.json keeps (newer, markReload), the server's own stop for onStop, and the build named in the page and each hello.
	// 0.18.0 to 379 for the font: its type, and a cache that keeps it (its name carries its hash).
	// 0.20.0 to 386 for a unit's queue (Queued) and the image route, with its cache for entries that never change.
	// 0.24.0 to 387 for a subagent's `ended` on its unit, so the page clears its finished alert.
	// 0.25.0 to 388 for a unit's background monitors (the Monitor type on Unit and on the tower).
	// 0.27.0 to 299: the one-server-per-machine record and handover (gui.json, requestStop, sharedGui) came out into handover.ts, which has its own figure.
	// Remote listener: a second loopback server with its own handler, port, and close, so a request is remote by the listener it arrived on: 299 to 320.
	// Unreleased to 323: finished subagents a page dismissed stay hidden until they leave the net (net.ts), and gui.ts hands the dismissal to control.
	// Unreleased to 327: a tower's subagents, collected as a member's are (net.ts: the towers' rows, one subagent builder for both).
	// Unreleased to 335: Dismiss finished (net.ts: dismissAll), the streams of one device told apart (gui.ts: remotes by device, the renewed cookie, remote/* shut to a paired device, the options and handlers for off, devices, and dismissAll).
	// Unreleased to 337: the stashed bases in the net (net.ts: the type and the list read with each snapshot).
	// Unreleased (net sidecar) to 338: `Unit.agent`, the agent of a unit that is not a pi session (net.ts).
	// Unreleased (comfort) to 343: net.ts types what a unit did lately (since, ticks, todo) and the net's events, and runs each reading through the activity tracker.
	// 0.42.4 to 351: an installed app's launch arrives from another site without the SameSite=Strict cookie, so a page load from outside reloads itself once (gui.ts).
	// Unreleased to 355: the server reads the net while no page listens too (gui.ts: the idle reading), for the timeline.
	// Unreleased (project trust) to 361 (on top of Straw Link's summary and channel): the snapshot's `trust` (net.ts: the type, the asks read with the world, the field), and the server's trust option (gui.ts: the answer route, the directory watch, its stop).
	// Unreleased (GUI in the sb server) to 376: gui.ts answers the server panel (server/status, server/log, server/restart) and the remote and stop options the server passes.
	// Unreleased (RC2-F001) to 387: gui.ts binds its ports first and keeps the token and CSRF secret only when it got the recorded ports back; on another port both are new.
	// Unreleased (R-F001) to 389: gui.ts answers a page load at a replaced address with a short HTML 403 and the words of the page's banner.
	// Unreleased (IRQ-F001, F003) to 390: the page-load 403's note in Traditional Chinese when Accept-Language asks for it.
	// Unreleased to 408 (sb server B5, GUI): net.ts (the tower service in the snapshot: TowerService, TowerView, the unit it makes of a standing tower) and gui.ts (the `tower` option and its route scope).
	// GUI fix pass (sb server B6) to 411: net.ts turns a live ally run with a known session file into a read-only unit of its own (key `ally-<run id>`, the path kept off the page).
	// T3 review fixes to 415: net.ts (`MemoryNotice`, a run's change to the memory that the boss can undo, in the snapshot); pi first (D23): `MemoryProposal` in its place.
	// T4 to 421: net.ts (`TowerConversation` on `TowerService`, the idle mark, and the event-run units, kept equal to runs.ts) and the tower option's conversation function in gui.ts.
	// T4 visual fix to 424: net.ts (`bossIn` on `TowerService`, kept equal to runs.ts).
	// Remote app entry (D25) with T4 to 440: gui.ts routes `/sb-app/` to appentry.ts, sends a dead or unpaired document load of this machine's user there, serves a remote page's manifest with the entry as its start URL, sets the pairing cookie for both paths, and hands the page the typed code.
	// Keep the token (D27) to 442: gui.ts takes the stored token and CSRF secret as `keep` and keeps them when it binds both of their ports (`kept` on the Gui).
	// Wi-Fi access (L5) to 466 (the RVL4 merge adds the documents' device and their revoke): gui.ts hands the LAN listeners the handler of kind "lan" (the entry, the verdict, the cookies, the documents' ticket, the streams keyed by network) and routes the `lan/*` reads and writes to this computer's page only.
	// Merge fix (MM-F001) to 468: gui.ts answers a LAN listener's favicon and touch-icon requests with an uncounted 404 before the verdict.
	// The server's default view (Geek step 3) to 478: gui.ts writes `sb-view` into the page it serves (the page is built per request now), puts `view` in the hello, sends the `view` event, and has `view()` and `setView()` on the Gui.
	// One-tap prompt run (feat/onetap-prompt-run): control.ts 392 to 395 (the grant issued with `then`, the grants store handed to the keys).
	// An answer that needs the terminal opens it (feat/answer-opens-terminal) to 479: gui.ts makes the pane grants (answerpane.ts) and routes `panes`.
	// Zen music (Z6) to 493: gui.ts takes the `music` option and routes GET /api/music (the list, and a track with its range) to music.ts, which has its own figure.
	// Z6 review fixes to 495: the music route closes an aborted request's file (pipeline) and answers If-None-Match with a 304.
	assert.ok(sum("src", ["net.ts", "gui.ts"]) <= 496, `src/net.ts and src/gui.ts have ${sum("src", ["net.ts", "gui.ts"])} lines`);
	// Input (the spec's figure), remote access over Tailscale, its terminal pairing panel (QR, c copies, o opens), and the QR encoder each have their own.
	// What a waiting session waits on (0.5.0, read for display only; answering is deferred) has its own as well.
	// 0.5.1 raised remote.ts from 165 to 185 (a recorded server counts as running only if its process started when the entry says: a reused PID
	// is not the owner) and ask.ts from 80 to 115 (the current branch's path instead of a line scan, a window that grows for a long call, and ask_user_question's list of questions).
	// The remote listener raised remote.ts from 185 to 192: the listener a request arrived on decides local or remote, and the old local-port entry is repointed.
	// 0.6.0 raised ask.ts from 115 to 125 to join relayed dialogs to what the file says (a unit with one waits before Herdr says blocked).
	// The sort key and sidebar marks of the net members (order.ts) are the sidebar plugin's data, kept apart from the coordination code.
	// 0.6.10 raised order.ts from 75 to 80 for `sb_indent`, the branch a subagent hangs on (its two glyphs and the check for a later marked sibling).
	// Unreleased raised it from 80 to 81 for `sb_name`, the subagent's own name: its line in the token list; the writes and the clear fit the lines they were on.
	// The dialog bridge (in every session), the owner adapters, and the hub have the spec's own figures; owners.ts is 120 instead of 90 because
	// rpiv-ask-user-question replaced pi-ask-user and speaks its own channel (prompt, answer, verdict codes, blocked), which its adapter maps.
	// The terminal mirror's reader (0.7.0) has the Phase 3 plan's figure, and so does the bridge's editor check (probe.ts, task 3), which
	// raised bridge.ts from 170 to 190 (the probe message, following gui.json from the start, the server's pid check) and dialogs.ts from
	// 160 to 185 (the probe sent and awaited for 1 s, and the bridges every reading binds by pane and file). The key pad's guards (keys.ts, task 4)
	// have the plan's 80; they came out of control.ts, which keeps only the dispatch. The mirror's reader is 135, not the plan's 130: it drops
	// the blanks Herdr pads every row with, which made a scrolling screen 12.8 KB/s against the plan's 12 (live check A1).
	// The document contract (documents.ts, Phase 3 task 6) has the plan's 60 plus 20: the hub's capabilities (minted per document and server, kept while a
	// bridge lists the document) live beside the adapter instead of in dialogs.ts. The plan's 190 for bridge.ts and 185 for dialogs.ts were to cover the
	// documents too, but the probe (task 3) took both; 0.8.0 raises bridge.ts to 195 (the documents in the message, cut first and counted in bytes, and the
	// form answer handed to the owner) and dialogs.ts to 210 (the documents checked in each relay apart from the dialogs, bound with the dialog rule, a
	// capability looked up in the bridge's current list, and the form answer checked, sent, and awaited for 5 s, with the three waits sharing one helper).
	// Document serving (docs.ts, task 7) has the plan's 150.
	// The tower's opening of a main (opener.ts, unreleased) has no figure in a spec: the sender check, the tab and its pi, the wait for the pi's role, the handoff text,
	// the close of a tab that failed, and the once-per-request memory. Raised 75 to 90 for the limits (review R-F001): the live-pane count per workspace and per sender,
	// the marker on the new pane, the serialising queue, and the refusal texts.
	// The orphan nudge (orphan.ts, 0.8.0) is a watcher of its own with no figure in a spec: what the registry and the transcript say about a finished child,
	// the debounce, the give-up counts, the check that the pane runs the child's own launch script (a pane that only reuses its session file, a resumed run
	// or a pi someone started there, is not the child), and the one message. Its session wiring is in index.ts, and its tests (tests/orphan.test.ts) own the rest.
	// The restored-subagent recovery (restored.ts) is a watcher of its own too: the same registry and transcript reads, the launch script's header to tell the restored pane (the run's own surface, running no launch script),
	// the worktree exception, the close, and the one message to the launcher; session.ts 205 to 207 for its wiring. Its tests (tests/restored.test.ts) own the rest.
	// 0.58.1: restored.ts 256 to 321 for the child cut off mid-turn (the intercom send to a worktree run's pane, the waits, the launcher's words about it), and cut.ts (118, new) reads where a session's turn was cut (the end of the file only) and words the message.
	// The watch on the Herdr server (server-watch.ts, unreleased) has no figure in a spec: one subscription connection whose closing says a new server took over, the
	// acknowledgement read off the socket, the retry ladder, and the stop. Its wiring in index.ts is counted with the rest below.
	// 0.11.0 raised control.ts from 150 to 156 for server/stop: another session's stop or takeover, checked like every write, never from a paired device.
	// 0.12.0 to 163 for remote/on: the pairing tile turns remote access on from the page and answers with a code, or why it could not.
	// 0.13.0 to 165 for dirs and open/*, handed to spawn.ts (the folder picker, a new main, a new base with its tower), which has its own budget.
	// 0.14.0 raised control.ts to 172 for the `/` menu's read (sessions/<key>/commands: a prefix checked, the hub asked, no Herdr call), bridge.ts to 198
	// for answering it with the session's matching commands, and dialogs.ts to 213 for the hub's request (probe and commands now share one helper);
	// the listing and its check are src/commands.ts, 32 at most.
	// 0.27.0 index.ts, the one closure that held every concern, is the composition root (51 lines at most in "the rest") and its concerns have a module and a figure each,
	// none in a spec: state.ts (what the modules share: the configuration, the one mutable State, the Kit they are built from), briefing.ts (the role prompt and its steer),
	// reach.ts (a message, a broadcast, status, and the tower of a workspace), election.ts (pin and claim: who is the tab's main), guard.ts (the tower and the mains go together),
	// presence.ts (the tokens a session publishes), membership.ts (the tab channel, its events, the join, and promotion), tools.ts (the agent's boss_* tools), tower.ts (the tower's start),
	// closing.ts (/boss close and the pane that closes after pi exits), host.ts (the GUI server this session hosts and its /boss gui commands), boss.ts (the /boss command),
	// and session.ts (the hooks at the session's start, around each run, and its end).
	// 0.27.0 towertab.ts (65 at most) holds what herdr.ts held for the tower's tab: finding a live tower or opening one, one opening at a time per workspace.
	// 0.27.0 handover.ts (93 at most) holds what gui.ts held for sharing one server between sessions: gui.json's record, the stop request, the takeover.
	// 0.15.0 raised control.ts to 176 for sessions/<key>/upload, a file's bytes under the same origin and CSRF checks, handed to upload.ts (50 at most).
	// Unreleased raised spawn.ts to 225 for the folder picker's new folder (makeDir: a plain visible name made inside a pickable folder) and its places (home, Desktop, Documents, the bases' folders), and added deploy.ts (63): an opening reports its steps (create, start, join, deliver) for the page to poll, and a refusal names its failed step.
	// Unreleased raised spawn.ts to 227: a folder made by a swapped link is taken back, and Windows-reserved names are refused.
	// 0.15.0 raised spawn.ts from 123 to 168: a base opens with a member and no tower, a base without a tower takes members (split into a squad or in
	// a new tab), only one with a tower takes mains, and every opening shares the start, join wait, first message, and close-on-failure.
	// Unreleased raised remote.ts to 203: paired devices saved (hashed) for the server a /reload starts again, and the disable that keeps them; host.ts to 88 for `restore`, which turns remote back on after a /reload.
	// Unreleased raised control.ts to 181 for dismiss: a finished subagent hidden from every page.
	// Unreleased raised tools.ts to 80 and session.ts to 148 for the tower's digest (digest.ts, 45 at most): boss_rename notes the new name, a join and a
	// subagent launch note themselves, and the tower's run reads the lines into its section and clears them.
	// Unreleased raised tools.ts to 87: boss_rename labels a main agent's tab itself (tabLabel and the rename), since pi-auto-tab-name leaves a tab someone else labelled.
	// Unreleased raised spawn.ts to 169: an opening answers with the session in its pane (sessionAt), so the page goes to it.
	// 0.17.2 raised server-watch.ts to 110 for herdrEvents, the event stream the tower guard listens to.
	// 0.17.0 raised bridge.ts to 206 for `close`, the session asked to quit as /boss close does, and its answer.
	// 0.17.0 raised dialogs.ts to 217 for the hub's side of `close`: the request, its answer, and its drop when the server stops.
	// 0.17.0 raised control.ts to 178 for close/unit, close/tab, close/base, handed to closer.ts (70 at most).
	// 0.24.0 raised keys.ts from 80 to 103 for a desktop's keyboard under the pad's guards: typed text (one write of 1 to 64 printable characters),
	// a paste inside the bracketed-paste markers, Delete, and Ctrl or Alt chords, with Ctrl+Z refused and Ctrl+D and a second Ctrl+C confirmed.
	// 0.25.0 raised ask.ts to 130, bridge.ts to 242, and dialogs.ts to 223 to relay a session's background monitors with its dialogs, checked by
	// the hub and set on its unit; monitors.ts (75 at most) follows them from pi-loop-monitor's events.
	// 0.27.0 raised tower.ts from 42 to 44 (the dashboard subscribes to Herdr's events) and state.ts from 105 to 106 (the `world` dependency).
	// 0.28.0 raised order.ts from 81 to 97 (`unplaced`, whether a launched subagent still has no pi pane) and presence.ts from 57 to 93 (the subscription to Herdr's events that marks such a subagent when its pi is detected, and the reading it triggers).
	// 0.28.0 raised ask.ts from 130 to 135: a file's open calls (OpenCall) go to merge with its pending, so a dialog can bind to one of several; dialogs.ts from 223 to 228 for the binding itself and the secret_drop check among several calls.
	// 0.28.0 raised owners.ts from 120 to 139 (the secret_drop owner: its pending shape and digest, one contract adapter parameterised by shape), dialogs.ts from 228 to 237 (the secret binding, its answer check, and its remote refusal),
	// ask.ts from 135 to 144 (forRemote: the net a paired device sees), and control.ts from 178 to 179 (a value never comes from a remote page).
	// The secret's end-to-end seal (seal.ts, 56, the envelope on its own) raised bridge.ts from 242 to 250 (a key pair per secret dialog, relayed with it, dropped when it closes; a sealed
	// answer opened before the owner hears it, a plain one refused) and dialogs.ts from 237 to 271 (each secret dialog's key pinned at first sight so a changed or missing one leaves it
	// in the terminal, and the value sealed to it as it leaves).
	// Secret entry left the GUI (SB-F001): ask.ts is back to 136 (no forRemote), bridge.ts to 246 (no key pair; a secret dialog is not relayed), and dialogs.ts to 237 (no key pinning, no sealing).
	// Unreleased: intercept.ts (143, new: the wrap of ctx.ui.select and confirm, a dialog contract owner under straw-boss:ui) has its own figure. owners.ts 139 to 145 for that owner
	// (`twin`, a confirm's flag in the select and its digest), bridge.ts 246 to 250 for the rule that a twin yields to a contract owner's dialog on the same tool call,
	// and control.ts 179 to 180 for the refusal of a confirm from a paired device.
	// Unreleased raised ask.ts to 139: a unit that is idle while a subagent of it commands (by a monitor) commands too, after the loop; a running monitor makes an idle unit commanding.
	// Unreleased raised host.ts to 97: a new server resumes remote when it was wanted on (resume) and the page's remote off; to 105 for resuming only as the remembered Tailscale identity, and for a /reload from a build up to 0.32.1.
	// Unreleased raised control.ts to 191 for remote/off, remote/devices, remote/unpair, remote/unpair-all and dismiss {all} (the confirm refusal is gone), and remote.ts to 216 for
	// the wish to keep remote on, the unpair calls, and the renewing cookie check; the paired devices themselves (saved hashes, names, sliding expiry) are devices.ts, 95 at most (a failed save is caught and kept as `error`).
	// Wi-Fi access, access (L4, docs/specs/2026-10-30-sb-gui-lan.md): devices.ts to 192 for lan.json's store (the same hashed, sliding pairings, bound to the token's hash) and the shared atomic write; remote.ts 267 to 283 for the network argument
	// (`pair` and `pairCode` for a surface, `check` for the LAN, `ended` per network, the list over both stores); appentry.ts 58 to 125 for the LAN's entry (the token-free pair page, the waiting page); paircode.ts 36 to 111 for the LAN's codes
	// (per-peer locks, the per-code ceiling counted per code, one live code per surface; 112 after RVL4-F004); docs.ts stays within 150 for the ticket. The LAN half of `createAccess` is src/lan/access.ts (232, then 246 for the wrong-number budget of `approve`, RVL4-F003).
	assert.ok(count("src/lan/access.ts") <= 246, `src/lan/access.ts has ${count("src/lan/access.ts")} lines`);
	assert.ok(count("src/devices.ts") <= 192, `src/devices.ts has ${count("src/devices.ts")} lines`);
	// Unreleased (stash and pop, docs/specs/2026-10-22-stash): stash.ts (221, new: Herdr's side of the check and its second look, the manifest checked before anything closes, stashBase on the server, popBase claiming the manifest on disk, with its start order, under the popping session's agent dir
	// and cleanup) and stashing.ts (46, new: /boss stash through the GUI server, /boss pop here) have figures of their own. bridge.ts 250 to 261 for `stash-check` (the session's
	// own reasons: a turn, a queue, a dialog, a running monitor), its answer, and a stash's close that is refused when the session stopped being stashable; dialogs.ts 237 to 240 for the hub's request and its answer; control.ts 198 to 199 for close/stash
	// and the refresh handed to it; handover.ts 93 to 111 for postServer, a POST to the recorded server as its page sends one; boss.ts 36 to 40 for stash, pop, and the stash names in Tab; closer.ts 70 to 71 for close/stash's batch asking `ifStashable`.
	// Unreleased (GUI takeover): handover.ts 111 to 166 for the record's `started` and `stopped`, the owner check a survivor decides on (ownerGone), and adoptGui with the lock shared with sharedGui; host.ts 111 to 152 for
	// the watch that adopts a server whose session ended without a stop, the mark a stop leaves, and the server's start taken out of `share`; state.ts 106 to 110 for the two dependencies (`gone`, `adoptMs`); session.ts 148 to 149 for the watch.
	// Unreleased (GUI takeover review): handover.ts 166 to 217 for `adoptable` (an old build's record, another Herdr's, a newer build's), the identity `markStopped` matches, `stopRecorded` (a stop under gui.lock), and `clearStale`
	// (a dead session's lock taken over by one session at a time); remote.ts 225 to 227 for the `plain` text a server that starts again prints; bridge.ts 261 to 262 for skipping a host whose process is gone.
	// Unreleased (close all): stash.ts 221 to 262 for closeAll (the invoker's own base checked as a stash checks it, looked at again before it closes, the server's session asked again when it sits there) and the check shared with it;
	// stashing.ts 46 to 58 for /boss close all through the server; closer.ts 71 to 74 for close/all; boss.ts 40 to 41 for its Tab entry.
	// Unreleased (GUI takeover, second review): handover.ts 217 to 230 for `keep` (a restore or a stash that leaves a stopped or down server alone under the lock), `downgrades` (a newer build's server, split out of `adoptable`), and `blind`; host.ts 152 to 164 for the
	// looks a survivor waits (a tower one, anyone else two, an older build three), the one warning when `ps` cannot read the start time, and `share` with `keep`; session.ts 149 to 150 for the Herdr check of the newer-version takeover; stashing.ts 58 to 62 for refusing a stopped server.
	// Unreleased (tower comms, docs/how-it-works.md "Talking between towers"): header.ts (31, new: the line every message opens with), closemain.ts (91, new: a tower asks a main it opened to quit, over the control channel; the main's own checks),
	// headwatch.ts (21, new: the digest line when the head tower changes). reach.ts 96 to 189 for the reading of the net and a message under its header (read, partyOf, deliver, post, callTower), the stations a message for a tower reaches (a tower, else mains, else members),
	// and tower_list and tower_send; tools.ts 87 to 101 for those tools and boss_close_main (and call_tower and boss_broadcast moving their bodies into reach); opener.ts 90 to 93 for the tower named in the handoff;
	// tower.ts 44 to 51 (a shutdown during the start stops it), session.ts 150 to 154 and state.ts 110 to 112 for their registration and the head watch.
	// Straw Link step 3: state.ts 112 to 113 for the `link` dependency (src/link/runtime.ts) tests shorten; tools.ts 101 to 109 for `device` on tower_send and the remote section of tower_list;
	// header.ts 31 to 43 for the verified sender of a remote message (remote=, device=, team=, verified=yes).
	// Straw Link step 4: owners.ts 145 to 148 for the remote-turn gate as a dialog owner (src/link/gate.ts); state.ts 113 to 115 for `remoteOrigin`; header.ts 43 to 47 for `origin=` on a message a tower sends during a remote turn.
	// Unreleased raised session.ts 160 to 171: the sub-workspace check at session start runs in the background, so pi-intercom connects without waiting for Herdr, with the barred-while-checking state, the guard against a later session start, and a subagent launch that waits for the answer.
	// Unreleased (comfort): activity.ts (47, new: when each unit took its state, its last steps, and the net's events of 30 minutes, kept across the server's reads, a reading after a gap a fresh start; no run-time import, so the demo runs it too) and todo.ts (29, new: a session's todo list in short from its branch, and the hub's check);
	// bridge.ts 262 to 275 for reading that todo list from the branch after each tool call, turn, and tree move and sending it when it changed; dialogs.ts 240 to 243 and ask.ts 141 to 143 for relaying it to its unit.
	// Unreleased (Herdr restore): roles.ts (63, new: the record each tower and main keeps of its role, by session file, pane, and tab, so a resumed pane takes it back); state.ts 112 to 115 (the session file and the restored flag),
	// membership.ts 115 to 120 (a main records itself, and a restored one does not open a second tower), tower.ts 51 to 54 (records and forgets), session.ts 171 to 178 (the record read at the start, a resumed main promoting, closing dropping it), and sidecar.ts 347 to 348.
	// Unreleased (merge of Straw Link step 3 and the Herdr restore): state.ts 115 to 116, the link dependency beside restoreMs; then 116 to 118 for the remote origin and the merge of step 4.
	// Unreleased (restore hardening): roles.ts 63 to 107 (the terminal and workspace a record must match, one main record a tab and the lookup of it, a sweep that cannot fail the write) and guard.ts 83 to 103 (the wait for the main a restore brings back), and session.ts 178 to 189 (the record read before joining, a stale main's record dropped, the restored flag reset when the start ends).
	// Unreleased: host.ts 164 to 170 for the page's channel to the link holder. tools.ts to 126 for link_request (its parameters and the call into the link module). control.ts 199 to 222 for the page's Straw Link calls (link/<name> to the holder, refused to a paired device unless it only reads).
	// Unreleased (restored opener): roles.ts 109 to 121 and session.ts 194 to 203, the marker of a main a tower opened kept in its role record and written back when a Herdr restore gives the main its role (the tower that opened it closes it again).
	// Unreleased (Windows hidden folders): spawn.ts 227 to 239 for the attribute reader the picker asks (listing, pickable, makeDir, the request wrapper), and hidden.ts (61, new: the cmd.exe reader, its cache, and the walk down a path).
	// Unreleased (Windows short names): spawn.ts 239 to 245, the path as given is read from home as the caller spelled it as well as from the real root (an 8.3 short name is rewritten by realpath).
	// Unreleased (desk mode R1): handover.ts 230 to 268 for gui.json written by rename (`writeRecordFile`) and the record written again when this process's start time arrives (`late`); startof.ts (99, new: the start time of a process, from `ps` or, on Windows, a PowerShell call read in the background, with the own-PID retries and the per-PID failure backoff).
	// Unreleased (the queue's Edit): control.ts 223 to 254 for the dequeue route (take id, the begin and finish around the key, the reasons told to the page), bridge.ts 275 to 320 and dialogs.ts 243 to 255 for the bridge's begin and finish (the queue mirror it checks the pulled text against, the deadline, the take-back it keeps for the same id asked again) and the hub's request, keys.ts 103 to 115 for Alt+Up under the guard and the rate, and pull.ts (37, new: how the pulled messages are told from the draft).
	// Unreleased (sb server B6): server/main.ts 560 to 581 (the control commands for an ally run's tools and the one-a-minute restart limit), towers.ts 607 to 662 (the ally run's pane and begin), towerstore.ts 264 to 265.
	// Unreleased (sb server B6): runmode.ts 314 to 366 for the ally mode of a run (its claim, the sender pinned as one remote turn, the confirm through the server, the ally role prompt) and the local run's link_request and ask-for-a-main tools.
	// Unreleased (sb server B6): header.ts 47 to 53 for `asks=` (the ask id of a message an ally run answers) and `for=` (the tower that asked for a link_reply), each checked as the code writes it.
	// Unreleased (sb server B6): tools.ts 177 to 186 for tower_send's `for` and `inReplyTo` (their schema and the refusal outside a run) and link_request in a local run.
	// Unreleased (sb server B6, RV7): bridge.ts 323 to 327 for hub.json, the pointer to the hub of a server that has no gui.json, read when gui.json names none.
	// Unreleased (sb server B6, review fixes RV6): runmode.ts 366 to 375 (an unpinned ally claim shuts down), dialogs.ts 285 to 298 (the hub's `track` and the shared `join`), main.ts 581 to 593 (the config problem told once, the confirm kept by its requester), towers.ts 662 to 698 (the ally runs' routes, answers and ledger), towerstore.ts 265 to 267, towerruns.ts 21 to 28 (the `problem` of an unreadable config.json).
	// Unreleased (sb server B6): dialogs.ts 258 to 285 for the hub's note of a yes (`allow`) on a gate or approval that closed with one and its lookup by the server.
	// Unreleased (sb server B6): owners.ts 152 to 153 for the `allow` a gate's or approval's close carries (the server's Allow check of an ally run's gated call).
	// Straw Link GUI follow-up: control.ts 222 to 223 (a paired device's answer to a `hereOnly` choice is refused 403 local_only) and owners.ts 151 to 152 (`Choice.hereOnly` passes through selectOf).
	// Straw Link work board (step 5b): board.ts, boardset.ts, and boardread.ts are new and have their own figures (the entry rules and files; board_set and its sidecar command; board_read); tools.ts 129 to 157 for board_set and board_read (their parameters and the calls into boardset.ts and boardread.ts); state.ts 118 to 120 for `boardId`; reach.ts 189 to 192 for the project scope of tower_list and exporting `read`.
	// Straw Link hereOnly keys: control.ts 100 to 110 and 186 to 223 (the link_request check, read from the session file and from the dialog the owner relays, is made for the prompt, for the key pad again right before each write, and for the queue's Edit), ask.ts 143 to 145, keys.ts 51 to 55 and 66 to 69 (a paired device sends only Escape, and no prompt or take-back, while a link_request is open), dialogs.ts 149 for `has`, and tools.ts for the nested-call block.
	// Unreleased (project trust, docs/specs/2026-10-26-project-trust.md): the trust relay has its own directory, src/trust/ (found.ts, files.ts, ask.ts, serve.ts, wait.ts, types.ts), with figures below. The existing modules gained the few lines that reach it:
	// control.ts 199 to 201 (the trust/answer route), spawn.ts 245 to 248 (the join wait past a trust question, the opening for a pane), stash.ts 284 to 286 and towertab.ts 65 to 71 and opener.ts 93 to 96 (the same wait), stashing.ts 62 to 63, tools.ts 109 to 110 and reach.ts 189 to 190 (the trust directory handed on),
	// deploy.ts 63 to 98 (the `trust` step and the question in the progress, the opening of a pane), host.ts 164 to 169 (the trust service and the openings it shares with the spawn), handover.ts (`trust: 1` in gui.json, no new line), index.ts 66 to 68 (the relay registered before the subagent return).
	// Unreleased (the queue's Edit sends pi's own dequeue key, Alt+Q on Windows and WSL or the user's binding; src/dequeuekey.ts is new, pi-free for the server side, and src/dequeuebind.ts, the bridge's half that reads pi's bindings): control.ts 5 lines (the key the bridge names, its refusal naming the key that went), bridge.ts 3 (begin names the key), keys.ts 2 (the key is a parameter, checked), pull.ts 2 (the `key` and `no_key`).
	// Unreleased (settings check, trust/settings.ts looked at before pi starts in a folder): stash.ts 286 to 289, spawn.ts 248 to 256, towertab.ts, opener.ts, closer.ts 87 to 90, towertab.ts 71 to 74, opener.ts 96 to 99, deploy.ts 98 to 99 (the refusal's facts in the progress; one line each, the look and where its refusal goes).
	// Unreleased (GUI in the sb server B2): server-look.ts 190 to 216 for `ask`, the one request a session sends the server for the GUI (the boss's own start, an automatic one, or none).
	// Unreleased (sb server B1, docs/specs/2026-10-26-sb-backend.md): server-look.ts (166 at B1, 184 after its review fixes: the version of the package on disk, the upgrade that is not newer; 190 after the re-check: a failed upgrade is retried on the versions, not on time; new: what a session does about the sb server, which starts it at session start, upgrades it, and answers /boss server and boss_server);
	// state.ts 120 to 121 (its dependency and Config field), tools.ts 157 to 177 (boss_server: its parameters, its three actions), boss.ts 41 to 44 (/boss server and its three completions).
	// Unreleased (GUI in the sb server): control.ts 274 to 286 for the server panel routes (server/status, server/log, server/restart) and their checks.
	// Unreleased (sb server B4, docs/specs/2026-10-26-sb-backend.md): opener.ts 99 to 116 (the ledger a server keeps, and its row), headwatch.ts 21 to 33 (one reading for many workspaces), reach.ts 195 to 205 (the tower asked of the server, and the hand-over), main.ts 292 to 298 (a claim or run request is told to wait until the runs are loaded), towers.ts (loaded(), the resend cap, stop with quitRuns), towerstore.ts 207 to 255 (the purge skips folders and ages out parked events; purgeAll removes everything B5 wrote), boss.ts 15 and 36 (B5 review: a run takes no /boss command), server-look.ts 36 and 202 (the look is quiet in a run), reach.ts 64 to 82 and 205 to 210 (B5 review: the server's resend cap for a run's tools, and a workspace broadcast that reaches the identity and not a run's pi),
	// guard.ts 110 to 123 (a tower identity counts as live through a fresh restart of its own slot's server), tower.ts 54 to 70 (a resident tower hands over; one more ask after a failed hand-over), reach.ts to 219 and membership.ts (a server stopped on purpose is told once per session), server-look.ts (the context it gives reach).
	// Unreleased (work board auto-fill, docs/specs/2026-10-25-straw-link.md, Auto-fill): boardauto.ts (the derivation and the scrub) and boardfill.ts (the session's writer) are new and have figures of their own; board.ts 159 to 179 (`src`, `count`, `who`, `forAllies`); the T2 review fix (name and count only for allies, the clean-first scrub, more secret shapes) took boardauto.ts 103 to 111 and boardfill.ts 74 to 75, boardset.ts 35 to 42 (where the entry goes, shared with `auto`), boardread.ts 43 to 47 (the name scrub for allies; the T2 re-check fix: the labels of a remote turn go through `allyLabel`, scrubbed first and cut last), reach.ts 254 to 262 and tools.ts 197 (`boss_status` and `tower_list` for an ally through the same gate, and `boss_status` scoped to the bound project like `tower_list`) and todo.ts 29 to 33 (`todosOfBranch`), tools.ts 186 to 196 (`board_set { auto }` and the refill after `boss_rename`).
	// Merge of 0.47.0 into B6: session.ts 209 to 215 (B6's figure plus the restored-subagent poll 0.47.0 added at session_start).
	// Unreleased (sb server B6, RV8): bridge.ts 327 to 330 (the first live of gui.json and hub.json is joined).
	// Todo #13 (sidecar pipe proof): paths.ts 114 to 118 and cli.ts 172 to 173, the secret in the state file and `ask` through the proof-checked handshake.
	// Todo #13, R13 fixes: paths.ts to 125 (`proto` in the state file, `SidecarProtocol`, a failure after the request was written is not "no sidecar"), cli.ts to 181 (join retires a sidecar of an older protocol, the exit-2 words for a protocol mismatch); legacy.ts (33, new) is that retirement.
	// D19 (call timing): header.ts 53 to 90 for `why` and `fieldsOf`, which the server reads a milestone by; reach.ts 254 to 259 for the reason of call_tower; tools.ts 186 to 190 for call_tower's `why`, optional for a tower.
	// T4 (boss conversation): control.ts 321 to 335 (tower-leave, tower-new, the composer's /quit and /new routes), boss.ts to 80 (the /boss tower words); towers.ts to 855, gui/chat.ts to 334, session.ts to 142, composer.ts to 310 for the conversation's route, box, and composer rules.
	// Remote app entry (D25, the installed app's fixed entry and its typed code): remote.ts 229 to 267 (the identity check shared by `check`, `entry`, and `redeem`, the second cookie, the code line of the QR screen); appentry.ts (58, new: the entry's HTTP and pages) and paircode.ts (36, new: the short code and its tries) have figures of their own. Pair-code entry (found live 2026-10-31): the pages and their script moved to entryform.ts (68, new) as eight boxes; paircode.ts to 41 for the normaliser (NFKC, any dash or space) and the box join.
	// Unreleased (fix/board-stale review round 1, RV-F001 to F007): boardfill.ts 92 to 116 (the withdrawal kept in the session across a /reload, a reload's line kept with its own age, the file claimed at session start); board.ts 187 to 192 (the purge re-reads the file before it removes it, the commanding flag of a main); cli.ts 167 to 171 (`board --clear`).
	// Unreleased (fix/board-stale review round 2, RV2-F001 to F003): the reload seed and the withdrawal record left boardfill.ts (116 to 108) for boardseed.ts (new, 34); board.ts 192 to 190 (the bare block of readOne); cli.ts 171 to 172 (`--clear` refused outside `board`).
	// Unreleased (work board clearing, fix/board-stale): tools.ts 202 to 209 for board_set's `clear` (its parameter and the refusal); board.ts 179 to 187 (finished auto entries purged and hidden, the stale mark for an idle main); boardfill.ts 75 to 92 (clear, the finished entry's removal, taking a reload's file as its own); boardauto.ts 117 to 118 (no list, no entry).
	// Wi-Fi access (L5): control.ts 335 to 371 (the `lan/*` routes and their panel type, the overlay-open mark right before each write of input, keys, and dequeue); keys.ts and server-look.ts a line or two each (the mark in the guard, the waiting-request notice).
	// Pi paths re-review fixes: control.ts 374 to 376 (the same refusal on a new session's first message and `gui view <mode>`), the chat chunks to 208,400 bytes / 82.2 KB gzipped (the composer's own `local_only` message in both languages).
	// Pi paths review fixes: boss.ts 90 to 91 and bosspaths.ts 232 to 234 (the stash --workspace refusal); control.ts 371 to 374 (the paired-device refusal of the boss's pairing, remote, Wi-Fi, and server commands typed into a session composer).
	// Merge of main 0.49.1 into the Wi-Fi branch (pair-code entry, 8 boxes): appentry.ts 58 to 106 (the Wi-Fi entry's routes beside the Tailscale one; its pages moved to entryform.ts with the Tailscale ones), entryform.ts 68 to 92 (the Wi-Fi QR, waiting, and notice pages), paircode.ts 41 to 115 (the Wi-Fi codes beside the typed ones); the figures for the Wi-Fi work above are unchanged.
	// Merge of main into the pipe-proof branch: the larger of each figure (server-look.ts 246, with the held-server notice of R13e-F002, and startof.ts 142 from this branch, the rest from main).
	// Cancel (fix/ask-cancel): control.ts 384 to 385 (a paired device cannot cancel a dialog whose choices are all hereOnly), bridge.ts 330 to 331 (a cancel for an owner without a path, or carrying a choice, is refused), owners.ts 153 to 155 (`cancellable`, `Answer.cancel`), dialogs.ts 298 to 302 (`checkAnswer`'s cancel and the flag on what the page may answer), intercept.ts 177 to 180 (a cancel is Escape: undefined for a select, false for a confirm).
	// Dialog forwarding (feat/link-unattended-dialogs): dialogs.ts 302 to 331 (`onChange` for subscribers with no page, `answerable`, `outcome`: what the sb server forwards to a controller, and when a dialog is closed); the forwarder itself is src/link/dialogs-out.ts.
	// Unit status and notices (S5): server/main.ts 625 to 663 (measured: the unit reporter's wiring to the towers, the hub and the holder, the runs' signal, the failed-tower-open notice, and the 15 s timer), dialogs.ts 331 to 333 (measured: the hub's `monitors`, the running monitors with their panes).
	// Dialog forwarding (feat/link-unattended-dialogs): main.ts 612 to 623 (the forwarder's late-bound wiring to the hub and the holder, its start and its stop).
	// Quit tower for the server's own tower (fix/tower-close): closer.ts 90 to 93 (a service tower has no pi to ask: its Quit tower ends the service, and a squad or a base is closed without asking its identity).
	// Quit with a run's pi in the service's pane (fix/tower-close): closer.ts 93 to 99 (the standing pane's sessions are the service's, which ends before the tab or base closes) and stash.ts 290 to 296 (the same pane in a survey, and a stash of a service tower refusing).
	// An answer that needs the terminal opens it (feat/answer-opens-terminal): control.ts 385 to 392 (the `then` of an accepted answer, the `panes` scope, the grants dependency; the routes themselves are in answerpane.ts).
	// Answer-terminal P3 fixes: answerpane.ts 109 to 119 (the tag claim: a tagged choice is granted only the pane carrying sb_answer), mirror.ts 140 to 145 (the bare reader looks at its pane with every read and drops its grant when it ends); owners.ts and control.ts carry `tagged` in place.
	// An answer that needs the terminal opens it (feat/answer-opens-terminal): owners.ts 155 to 163 (`Choice.next`, `Then`, the robot_hand label reading), mirror.ts 135 to 140 (the bare reader, which ends on a pane that runs an agent or carries sb_role: one import line), keys.ts 122 to 133 (`bare`), and answerpane.ts (109 after the review fix that ends a grant on a pi pane or a tower, new: the grants, the pane routes, `thenOf`).
	// Head tower H2: dashboard.ts 175 to 177 (the head tower listed first, no tag on a workspace tower) and stash.ts 296 to 297 (a stash of the head workspace is refused).
	// Head tower H2: towers.ts 1106 to 1135 (the wiring only: the head attached to the run hub, its brief and tool host, its intake, `head.event`, the opened/closed digest lines; the rules are headside.ts, headtools.ts, headgate.ts, headasks.ts), runallow.ts 75 to 81 (the head's run tools).
	// Head tower H2 (docs/specs/2026-11-04-head-tower.md): headwatch.ts is gone (the server notes `head tower opened` and `head tower closed` itself); reach.ts 267 to 270, tools.ts 209 to 214, and header.ts 90 to 97 for the head's `ask=`, `relay=`, and `in-reply-to=` fields, the head party in a header, and `tower_send {head, inReplyTo}`; the head's two sends and its reading in the net are reachhead.ts (new).
	for (const [name, max] of [["commands.ts", 32], ["control.ts", 402], ["stash.ts", 297], ["stashing.ts", 63], ["closer.ts", 99], ["upload.ts", 50], ["music.ts", 83], ["spawn.ts", 256], ["hidden.ts", 69], ["deploy.ts", 99], ["remote.ts", 283], ["appentry.ts", 104], ["paircode.ts", 115], ["entryform.ts", 92], ["pairing.ts", 60], ["qr.ts", 140], ["ask.ts", 145], ["bridge.ts", 331], ["owners.ts", 163], ["answerpane.ts", 119], ["dialogs.ts", 333], ["seal.ts", 56], ["monitors.ts", 75], ["activity.ts", 47], ["todo.ts", 33], ["order.ts", 105], ["mirror.ts", 145], ["probe.ts", 40], ["keys.ts", 150], ["pull.ts", 40], ["dequeuekey.ts", 18], ["dequeuebind.ts", 61], ["documents.ts", 80], ["docs.ts", 150], ["orphan.ts", 115], ["restored.ts", 321], ["cut.ts", 118], ["opener.ts", 116], ["handover.ts", 268], ["towertab.ts", 78], ["state.ts", 121], ["roles.ts", 121], ["briefing.ts", 33], ["reach.ts", 270], ["election.ts", 24], ["guard.ts", 123], ["presence.ts", 93], ["membership.ts", 131], ["tools.ts", 214], ["boardauto.ts", 118], ["boardfill.ts", 108], ["boardseed.ts", 34], ["tower.ts", 74], ["closing.ts", 37], ["host.ts", 175], ["lanface.ts", 367], ["boss.ts", 100], ["bosspaths.ts", 237], ["bossopen.ts", 246], ["memorycmd.ts", 159], ["session.ts", 215], ["digest.ts", 49], ["closemain.ts", 91], ["header.ts", 97], ["intercept.ts", 180], ["endpoint.ts", 24], ["startof.ts", 142], ["board.ts", 190], ["boardset.ts", 42], ["boardread.ts", 47], ["server-look.ts", 246]] as const) assert.ok(count(`src/${name}`) <= max, `src/${name} has ${count(`src/${name}`)} lines`);
	// 0.19.0 to 258 for the todo list: rpiv-todo's snapshots marked as the index reads them, and the newest one read for a reset or a change that adds one.
	// Unreleased (net sidecar): composer.ts 191 to 192 and tokens.ts 23 to 24 for the agent badge and the composer's notice for a unit that is not a pi session.
	// Unreleased (net sidecar): src/agent/ holds the net sidecar of a Claude Code or Codex session (docs/specs/2026-10-23-claude-codex-net): kit.ts (the modules' two pi dependencies over a raw
	// intercom client), paths.ts (where its files and pi-intercom are), sidecar.ts (the session in the net), and cli.ts (what straw-boss runs: join, and the commands of straw-net.py). None of it is loaded by the extension or by the page, and none imports the host, the GUI, or the dialogs.
	// Unreleased (net sidecar review): claim.ts (45, new: the pane's state file claimed whole with a link, a leftover removed under a lock), paths.ts 78 to 106 (a holder is who answers on the socket, not a pid), cli.ts 147 to 158
	// (the wait per command, join through that holder), and sidecar.ts 332 to 347 (the shell-quoted hint, the relay marker and attachment note, the pi variables left out, a pane another agent has taken).
	// Unreleased (Windows): paths.ts 106 to 114, the control socket as a named pipe on Windows (a random name recorded in the state file, socketOf, and socketIsFile
	// for the steps a pipe skips); closing.ts 23 to 29, the wait for pi's exit in node on Windows, which has no sh.
	// Unreleased (closed main): closing.ts 31 to 37, the pane marked `sb_closing` before the quit (so the net never shows it outside the net while pi shuts down); the lines above moved by 3.
	// Unreleased: cli.ts 158 to 160, the directory pi-intercom is looked for beside (`here`), so a test runs the same in a checkout next to a pi-intercom checkout.
	// D19 (call timing): cli.ts 163 to 167 for call-tower's `--why` and `--reply`.
	// Straw Link work board (step 5b): sidecar.ts 349 to 363 for the `board` command and deleting the entry on leaving; cli.ts 160 to 163 for repeated `--item` flags.
	for (const [name, max] of [["kit.ts", 163], ["paths.ts", 125], ["sidecar.ts", 363], ["cli.ts", 181], ["legacy.ts", 33], ["claim.ts", 45]] as const) assert.ok(count(`src/agent/${name}`) <= max, `src/agent/${name} has ${count(`src/agent/${name}`)} lines`);
	// GUI fix pass 2 (sb server B6) to 263: the session file opened without following a symlink (GR-F004).
	assert.ok(count("src/history.ts") <= 263, `src/history.ts has ${count("src/history.ts")} lines`);
	// The item mapping and the stream glue came out of the reader to keep it within its budget; the spec sets no figure for them.
	// 0.19.0 to 108 for Todo and todosOf, a todo snapshot checked field by field.
	// GUI fix pass (sb server B6) to 110: a tower run's message carries the kind the server sent it with (`event`).
	// GUI fix pass 2 (sb server B6) to 113: the sender of a run event or link message cleaned and cut (GR-F005).
	assert.ok(count("src/items.ts") <= 113, `src/items.ts has ${count("src/items.ts")} lines`);
	// 0.20.0 to 106 for an entry's images served one by one as their bytes (image).
	assert.ok(count("src/watch.ts") <= 107, `src/watch.ts has ${count("src/watch.ts")} lines`);
	// Pane balance is a separate extension entry with its plain-JavaScript helper.
	// after-close ends when Herdr is gone (desk U13, BG-F001): balance.mjs 178 to 185, the locale-free `os error` set and its note.
	// Herdr's CLI with no server (desk U13 on macOS and Windows): balance.mjs 185 to 186 for `server_not_running` and its note.
	assert.ok(count("src/balance.ts") + count("src/balance.mjs") <= 223, "src/balance.ts and src/balance.mjs stay small");
	// The blocked relay (rpiv-ask-user-question, and pi's own dialog prompts) is its own extension entry too. It was 25 lines for the rpiv relay alone;
	// the dialog relay raised it to 42 for the label of a dialog's title and the signed count that keeps the pairs balanced when pi delivers an end ahead of its start, and the guard for an end that reaches a retired runtime.
	assert.ok(count("src/blocked.ts") <= 42, "src/blocked.ts stays small");
	// Worker process hygiene (sb procs T3): hygiene.ts is the pi side of the owner registry and the removal guard (its own extension entry, in every pi; the pure words of the guard are in src/procs/guard.ts).
	// Fixes of the T3 review to 274: the idle retained pane shell of the target workspace exempted, git's trailing-component names, a look that cannot run blocking, the implicit herdr workspace, the session read before any await, the terminal asked once.
	// Final-gate fixes to 282: a shell program required for the idle exemption (bare git keeps it off), unresolved targets blocked, only a refused reply permanent, a workspace id resolved outside a repository.
	assert.ok(count("src/hygiene.ts") <= 282, `src/hygiene.ts has ${count("src/hygiene.ts")} lines`);
	// Unreleased (sb server B5): runmode.ts is the pi side of a tower run (the claim, the poll loop, the tower tools as clients of the server, tower_done, the intercom block); it has its own figure. 313 after the B5 review and its second re-check (+1 for the import of the shared marker lines; the sender line cleaned of control, format and bracket characters, the flag line after the marker): the sender line, the subagent block, the 30 s out-of-reach window, the glyph-tab wait for pane-role, and the idle re-check at delivery.
	// Unreleased (sb net stand-in): runmode.ts 375 to 395 (the boss's keyboard input told to the server, tower_done's stay answer, and a quit told as the boss's leaving); T3 to 393 (the proposals' tools).
	// Unreleased (sb server B6, VM pass fixes): runmode.ts 393 to 408 (the run marks its process for balance.ts, and an ordered quit is held until the turn ends and dropped by a claim again).
	// Unreleased (sb server B6, VM fixes F10/F4 merge): runmode.ts 408 to 427 (the VM fixes and RV-F001/F003 on the run side).
	// T4 to 395: the brief refresh the poll carries and the boss conversation's quit told as `(boss quit)`.
	// RVAC-F003: runmode.ts 521 to 522 (the pane-role ask carries the pi's own session file).
	// RVAF-F001: runmode.ts 522 to 530 (an ally run writes its marker into its session, the pane-role ask says whether the session carries it).
	// Todo #31: runmode.ts 530 to 537 (a local run refused the tools off its list and the paths of the state folder, runallow.ts holding the rule).
	// Todo #31 review (R31-F002/F003): runmode.ts 537 to 542 (the path denial reaches ally runs and a hand run in a turn the boss did not start).
	// Head tower H2: runmode.ts 542 to 550 (the head kind: its tool set, the turn starter every call reports for `relay=boss`, and the head-run prompt); the head's `tower_send` is runhead.ts (new).
	assert.ok(count("src/runmode.ts") <= 550, `src/runmode.ts has ${count("src/runmode.ts")} lines`);
	// Todo #31: runallow.ts is the list of a local run's tools and the rule that refuses the rest and the paths of the state folder (the server passes it to pi, runmode.ts enforces it); it has its own figure; 63 to 75 for the path arguments by tool, the UNC refusal, and `refusedForRun` (R31 review).
	assert.ok(count("src/runallow.ts") <= 81, `src/runallow.ts has ${count("src/runallow.ts")} lines`);
	// T4: towercmd.ts is `/boss tower`'s subcommands (status, parked, retry, deliver, drop, leave, new, the tower prompt's words for them); it has its own figure.
	assert.ok(count("src/towercmd.ts") <= 137, `src/towercmd.ts has ${count("src/towercmd.ts")} lines`);
	// Pi paths 2 review fixes: control.ts 376 to 384 (`localOnlyText`: a paired device's `/boss open <kind> <dir> <text>` is tested for a gated command in <text> at any depth), intercept.ts 175 to 177 (`hereOnlyOpts`), bossopen.ts 241 to 246 (the page's step words, the base's name), bosspaths.ts 236 to 237 and server-look.ts 238 to 239 (the hereOnly confirms).
	// Unreleased (boss-typed pi paths, second batch): bossopen.ts (241, new) is /boss open base|member|main and /boss link [status] | link decide; boss.ts 91 to 93 and bosspaths.ts 234 to 236 for its two lines each.
	// Unreleased (boss-typed pi paths): index.ts 413 to 414 for the paths object; bosspaths.ts is /boss close <name>, close all <workspace>, stash --workspace, dismiss, gui devices and unpair, and server logs (232 lines, with its en and zh-TW words); boss.ts 80 to 90 for their lines.
	const apart = ["runmode.ts", "runhead.ts", "runallow.ts", "towercmd.ts", "board.ts", "boardauto.ts", "boardfill.ts", "boardseed.ts", "boardset.ts", "boardread.ts", "startof.ts", "commands.ts", "dashboard.ts", "netdata.ts", "net.ts", "gui.ts", "music.ts", "history.ts", "items.ts", "watch.ts", "balance.ts", "control.ts", "remote.ts", "appentry.ts", "entryform.ts", "paircode.ts", "devices.ts", "pairing.ts", "qr.ts", "ask.ts", "blocked.ts", "hygiene.ts", "bridge.ts", "owners.ts", "answerpane.ts", "dialogs.ts", "seal.ts", "monitors.ts", "activity.ts", "todo.ts", "order.ts", "mirror.ts", "probe.ts", "pull.ts", "dequeuekey.ts", "dequeuebind.ts", "keys.ts", "documents.ts", "docs.ts", "orphan.ts", "restored.ts", "cut.ts", "opener.ts", "spawn.ts", "hidden.ts", "deploy.ts", "upload.ts", "closer.ts", "server-watch.ts", "handover.ts", "towertab.ts", "state.ts", "roles.ts", "briefing.ts", "reach.ts", "election.ts", "guard.ts", "presence.ts", "membership.ts", "tools.ts", "tower.ts", "closing.ts", "host.ts", "lanface.ts", "boss.ts", "session.ts", "intercept.ts", "digest.ts", "closemain.ts", "header.ts", "reachhead.ts", "stash.ts", "stashing.ts", "bosspaths.ts", "bossopen.ts", "endpoint.ts", "server-look.ts", "memorycmd.ts"];
	const rest = sum("src", names("src").filter((name) => !apart.includes(name)));
	// 0.4.1 raised it from 540 to 575 for claiming and promotion; 0.5.0 to 610 for herdrCall (Herdr's answers with their error codes, spec task 4) and the /boss gui remote command;
	// 0.5.1 to 620 for a join retry that follows its session to another tab; 0.6.0 to 630 to start the dialog bridge before the subagent return and the hub with the server.
	// 0.7.0 to 650 for the order and mark tokens each session publishes with its role (order.ts, which has its own figure), the tab list they read,
	// and one publish at a time that shutdown waits for. 0.6.10 to 661: the role marks moved from order.ts to herdr.ts beside the tower label, so the
	// dashboard draws the sidebar's glyphs without importing order.ts, which imports the dashboard, and the towerModel setting (read at each tower
	// start and passed to pi as --model); 0.8.0 to 667 to mark a launched subagent within seconds of the launch, and to 681 for the orphan nudge's wiring
	// in index.ts (the watcher started at session start and stopped at shutdown, its few lines of state, the polling interval as a dependency tests can shorten)
	// and for the message id every send carries (a nonce per process: a restarted pi keeps its session id, and pi-intercom refuses a reused id with other content).
	// Unreleased: to 712 for the tower opening a main (opener.ts, which has its own figure): index.ts registers boss_open_main in the tower (its schema and texts, 18 lines)
	// and makes a pi started with STRAW_BOSS_ROLE=main promote itself after joining (4 lines); herdr.ts gained createTab and startPi, which the tower's own opening now shares (9 lines net). Raised 712 to 723 (review R-F001/R-F002) for index.ts claiming the one-time pane token and keeping the opener's marker fresh (11 lines). Raised 723 to 739 for the tower tab's lifecycle: a quitting tower closes its own tab when the tab holds only its pane (index.ts, 6 lines), and opening adopts a token-less leftover tab and closes surplus ones (herdr.ts, 10 lines). Raised 739 to 743 (review R-F001 on the leftover-tab fix): an adopted shell that stays busy gives its tower token back when pi cannot start in it. Raised 743 to 760 for the takeover wiring in index.ts (17 lines): the `watch` dependency, `restore` (the tower's marks first, then the full publish), and the watch started where a session joins and stopped at session start and shutdown. Raised 760 to 767 for Tab completion after /boss (index.ts, 7 lines): the subcommands with their descriptions and the getArgumentCompletions that filters them.
	// 0.11.0 to 783 for /boss gui from any session (index.ts, 16 lines): stop asks the running server, remote and remote off take it over first,
	// the owner's stop through onStop says who stopped it, and session start brings back the server a /reload or /new stopped (after a /new, once the new session's id shows) or takes over an older one.
	// 0.13.0 to 784 for the opening API (spawn.ts, which has its own figure): index.ts hands it to the GUI with the tower opening it reuses (1 line).
	// 0.17.0 to 855 for the tower and the mains going together (index.ts): the guard that promotes under a live tower, clears the mains when it quits or
	// stays gone past a /reload's grace, and opens a base's tower by its own rule (two members while another base has one); and closing (/boss close and
	// the bridge's close: quit as /quit, then the pane closes after pi has exited).
	// 0.17.1 to 857: a quitting tower records the members it leaves, and the two-member rule waits for the base to grow past them.
	// 0.17.2 to 885: the guard checks on Herdr's events (a workspace's tokens, this workspace's panes, the tab channel's owner) instead of every
	// 5 s, sets one timer for a check that has to wait, runs one check at a time, and can be left out (couple) where a test is about something else.
	// 0.21.0 to 905: boss_rename (index.ts, 11 lines), and a role that changes during a run reaching the agent as a steer (rebrief, 9 lines).
	// 0.27.0 to 193: index.ts (51) is the composition root and herdr.ts (142) the Herdr client; everything else the closure held has a module and a figure above.
	// 0.27.0 to 234: index.ts (53, the listings over the socket unless a run is injected) and herdr.ts (181: socketRun, the listings' socket requests, and the world as one session.snapshot or as listings asked together).
	// 0.28.0 to 235: index.ts (54), the delay before a subagent's pane is read once Herdr reports a pi (`detectMs`).
	// Unreleased to 237: index.ts (56), the wrap of ctx.ui installed beside the bridge (its import and one call).
	// Unreleased to 238: index.ts (57), the tower's digest built beside the briefing (its import).
	// Unreleased to 239: index.ts (58), /boss stash and pop built beside /boss (its import).
	// Unreleased to 241: index.ts (60), the two dependencies of the GUI takeover (`gone` with its import, `adoptMs` with its default).
	// Unreleased to 243: herdr.ts, `herdrSocket`, the socket a session's Herdr is named by, which the watches default to and gui.json records.
	// Unreleased to 244 (net sidecar review): herdr.ts, the `stderr` a failed herdrRun carries, so a caller reads Herdr's own code and not the line the message repeats.
	// Unreleased to 246 (tower comms): index.ts (62), the control channel and the head watch wired in (createCloseMain, its handing to the tools, the session, and the tower).
	// Unreleased to 248 (Windows): herdr.ts, the import of endpoint.ts (24, its own figure: Herdr's socket found as Herdr finds it, and a named pipe on Windows).
	// Unreleased to 269: herdr.ts, `pane current` and `report-metadata` over the socket too (socketRun, was socketReads), so a session start and the token refreshes spawn no Herdr CLI.
	// Straw Link step 3: 269 to 270 for index.ts importing createLink.
	// Unreleased to 270 (Herdr restore): index.ts (63), roles.ts built beside the briefing and handed to the membership, the session, and the tower (its import).
	// Unreleased to 273 (desk mode R1): index.ts (66), startof.ts imported and warmStart called at the session's start.
	// Unreleased to 275 (project trust): index.ts (68), the relay's import and its registration before the subagent return.
	// Unreleased to 307 (sb server B1, third review): winpath.ts 21 to 24 (a SystemRoot is taken only as a drive-letter absolute path).
	// Unreleased to 304 (sb server B1, pre-merge review): winpath.ts (21, new: the Windows system programs by absolute path from %SystemRoot%\System32, and the folder they run from).
	// Unreleased to 283 (sb server B1): index.ts (70), the look at the sb server built from the session's kit (its import and its handing to the tools and /boss); semver.ts (6, new: `newer`, which handover.ts, the server, and its look share).
	// Unreleased to 317 (GUI in the sb server B2): bridgewire.ts (10, new: what the dialog bridge and the hub agree on, apart from bridge.ts, which imports pi).
	// Unreleased to 320 (sb server B5, local runs): index.ts (73), the run mode built before the net (its import, the flag, and its handing to the session).
	// Unreleased to 323 (sb server B5, RV-F001): eventmarks.ts (3, new: the two lines the server writes at the head of a boss event, shared by runmode.ts and the page).
	// Unreleased to 355 (desk remainder, docs/specs/2026-10-26-desk-mode.md S6): integration.ts (33, new: the one warning a session gives when Herdr's pi integration is missing), index.ts (the check built and handed to the session).
	// Unreleased 355 to 357 (desk remainder, review): integration.ts (32), its own pane from the environment and the generation that drops a check finished after the session ended.
	// GUI fix pass 2 (sb server B6) 357 to 363: eventmarks.ts holds the one cleaner of an outside name (cleanLabel), shared by the sender line and the items.
	// Unreleased (sb server B7, review fix RVB7D-F002): towers.ts 878 to 879 (a claim is used once).
	// Unreleased (sb net stand-in, review): towers.ts 724 to 726 (the standing pane made by ensure is known fresh: standing.ts types into it where Herdr gives no foreground group).
	// Unreleased (sb net stand-in): order.ts 97 to 105 (an ally run's pane keys, written and cleared: allyKids, clearOrder).
	// Unreleased 357 to 375 (sb net stand-in): herdr.ts (the stand-in's label, seq, report and release); stash.ts 289 to 290 (the stand-in counts as a bare pane; towertab.ts stays within its 78).
	// Unreleased 381 to 382 (work board auto-fill): index.ts (76), boardfill.ts imported and built into the tools.
	// Unreleased 382 to 398 (tower memory, T3): the rest of src carries the memory's wiring.
	// Unreleased (sb server B6, VM pass fixes) 398 to 410: runmark.ts (9, new: the run mark balance.ts and runmode.ts share) and balance.ts (the quit of a run starts no helper).
	// Unreleased 410 to 413 (seat, RVSEAT2-F002): herdr.ts, StartUnproven and startPi's seat check before each retry.
	// Unreleased 414 to 419 (Windows ACL review WA2-F002): winpath.ts, `powershellEnv`, the one place a PowerShell 7 PSModulePath is dropped for a Windows PowerShell 5.1 child.
	// One-tap prompt run: runs.ts (38, new: the grants) and the hash in probe.ts (+1).
	// One-tap security review (OT-F001 to F005) 458 to 468: runs.ts 38 to 49 (the grant's nonce and its MAC, and no grant for a `/` command).
	// Merge of the one-tap run (runs.ts) and the towers' republish (towers.ts +13) to 481 (measured).
	// Head tower H1 (docs/specs/2026-11-04-head-tower.md) 481 to 492: herdr.ts (the crown label, the service kinds and their seat labels, `isHead` and `headTowerOf`, the head's stand-in label).
	// Head tower H2 492 to 493: reachhead.ts and runhead.ts are new (about 60 lines), headwatch.ts (33) and the resident tower's watch of it are gone, herdr.ts has `headModel`.
	// Head tower H3 (review fixes HH2-F001, F002) 493 to 543: headerfields.ts (47, new: the header reader moved out of header.ts, which re-exports it, with `withoutField` for the intake that drops `relay=` from anyone but the head identity).
	// Head tower H3 (docs/specs/2026-11-04-head-tower.md) 543 to 779: nethead.ts (the head unit of the snapshot), headhistory.ts (the history through the chapters), headroutes.ts (the head's routes), headcmd.ts (`/boss head`, with its words in two languages), headkey.ts; control.ts, boss.ts, and memorycmd.ts have figures of their own.
	// Head tower H3 review fixes (HH3-F003): control.ts 399 to 402 (the tower scope refuses the head's key and workspace, and the panel says which they are).
		// Head tower H4 review fixes 779 to 781: headhistory.ts has `whyCode`, the chapter reason code the divider carries.
	assert.ok(rest <= 781, `the rest of src has ${rest} lines`);
	// Unreleased (settings check, probe): settings.ts is the lstat gate, the child's program (refuses a link it cannot follow, stats before opening; review SR5), and its runner (160); it no longer walks links. settings.ts 92 (new: the look before pi starts in a folder), raised 92 to 135 for the link walk (every hop of .pi and settings.json, refusing /proc, /dev, /sys; review SP-R001).
	// Unreleased raised trust/ask.ts from 182 to 183 (RC3-F001): the recorded server's start time is read when the handler registers.
	// Unreleased raised trust/ask.ts from 183 to 201 (RC4-F001, F002): `warmServerStart` (the early read only for a live server that reads trust requests) and `guiUp` (what the handler's `up` asks) are exported for their tests, and `registerTrust` takes the terminal it answers on.
	// Unreleased raised trust/ask.ts from 201 to 209 (sbir6-F004): the early read asks the same predicate (`asks`) as the handler, plus pi's resource check; dashboard.ts 162 to 175 (sbir6-F005): rows render before the GUI read settles.
	// Unreleased raised trust/ask.ts from 209 to 235 (sbir7-F001, F002): the early read and the handler degrade on older pi's missing trust exports, and no relay under -p, another --mode, or --approve.
	for (const [name, max] of [["found.ts", 103], ["settings.ts", 160], ["files.ts", 160], ["ask.ts", 235], ["serve.ts", 110], ["wait.ts", 28], ["types.ts", 15]] as const) assert.ok(count(`src/trust/${name}`) <= max, `src/trust/${name} has ${count(`src/trust/${name}`)} lines`);
	// Unreleased (sb server B1, docs/specs/2026-10-26-sb-backend.md): the server's own directory, src/server/, has no figure in the spec; the files each hold one concern:
	// record.ts (server.json, server.lock, start-error.json, slots), log.ts (server.log, rotated), version.ts (the version rules), acl.ts (the Windows folder ACL by SID), socket.ts (the control socket or pipe and its hello secret),
	// After the re-check: log.ts 135 (the stale lock removed under a marker), client.ts 412 (the stop's scope check, the wait for a supervisor's serve as one function).
	// After the Windows VM check: record.ts 317 (the start's `restarting` written before the spawn, the lock written again with the holder's start time), client.ts 447 (the starter's touches, the stop's timings, the per-platform start wait),
	// main.ts 329 (`restarting` from the first line, the loader beside the ACL call, the phases), acl.ts 202 (the files already there repaired, the start time asked in the same call), , cli.ts 279 (the timer that holds the entry script), and startof.ts 114 (a read that an await holds the process open for).
	// After the second Windows pass: winprep.ts 34 (new: the state folder protected by whoami and icacls before the first file in it) and breakaway.ts 126 (new: the Windows server started through WMI outside the starter's job, its environment file); record.ts 328 (prepareSlot, the hook of the lock and the placeholder), client.ts 501 (one deadline for `up`, the waits named, the late pid), main.ts 359, cli.ts 295 (the env file, the deadline, `wait`).
	// After the third review: acl.ts 220 (execFailure: a failed program told by its stderr and exit code), winprep.ts 91 (two icacls forms, the link looked at again, one time for the calls), breakaway.ts 131 (the in-job command line), client.ts 525, main.ts 371 (a rival by start time or by change), record.ts 339 (the Detach type).
	// After the executable search: startof.ts 116 to 117 (the ps search), closing.ts 29 to 31 (the herdr and sh paths found by absolute path) and session.ts 203 to 205 (a pane that could not be closed is said on stderr, the shutdown goes on); exe.mjs (125) is apart from the budgets above, a plain-JavaScript module like balance.mjs.
	// After the second review (F001 to F007 and the system programs by absolute path): winprep.ts 84 (the folder made the owner's and read back at every start, links refused), breakaway.ts 129 (the environment as Win32_ProcessStartup.EnvironmentVariables, no file; documented flags; no fallback on a timeout), client.ts 521 (one deadline in every wait, the detach warning), main.ts 368 (a rival only on positive evidence, the detach record), cli.ts 296, record.ts 338, acl.ts 207.
	// After the pre-merge review: acl.ts 205 (one icacls reset for what is in the folder, the secondary slots' server.json read back), client.ts 454 (the lock wait that follows the timers, the live server's starting mark taken off), main.ts 345 (a start leaves another running server's record alone and gives up before it writes its own).
	// After VM pass 3: acl.ts 282 (the check's steps shared with the launch script, the marker the starter leaves and the server reads, a fixed failure text), winprep.ts 151 (the folder born under a temporary name and renamed, the failure messages), breakaway.ts 184 (the check inside the launch script, the error marker), client.ts 540, main.ts 377, cli.ts 302 (the token).
	// After the review of VM pass 3: acl.ts 290 (the message line of a PowerShell 5.1 error), winprep.ts 188 (/L, the link looked at first, the rename tried again, the leftover temporary folders swept), breakaway.ts 217 (the launch script answers once WMI made the process, whatever fails after it; no plain spawn then), client.ts 543 (the marker error logged).
	// After the re-check of a651496: acl.ts 313 (the CLIXML of a PowerShell stderr read as its error strings, the flags every PowerShell call shares), breakaway.ts 225 (the line before the create, the fallback when the script died before it), startof.ts 118 (the same flags and progress setting).
	// After VM pass 4: startof.ts 140 (startedOrWait), breakaway.ts 229 (the starter's start time in the launch answer), client.ts 562 (the late pid, the scope only while live, the stop message), main.ts 381 (start-error.json from a server that cannot prepare), record.ts 372 (the unreadable lock repaired), winprep.ts 264 (the owner read, the longer rename retry, the file reset).
	// After the review of 4957885: acl.ts 332 (ownerProblems: the exact owner from the read-back; the CLIXML decode guarded), client.ts 566 (the scope pinned while the record's process runs), record.ts 381 (the unreadable lock retried briefly).
	// After the re-check of 3ae1ab5: winprep.ts back to 229 (the owner listing is gone), acl.ts 340 (the folders below owned and read back), breakaway.ts 249 (the owner checked before the create), client.ts 575, record.ts 388.
	// After VM pass 5: acl.ts 349 (the Constrained Language Mode word and sentence), client.ts 592 (a denied probe, the hello before any start time), socket.ts 210 (`denied`, helloWhy), cli.ts 306 (the unreachable warning).
	// Todo #13 (sidecar pipe proof): socket.ts 220 to 230 (the request written after the proof, idleMs, the graceful close).
	// Todo #13, R13b fixes: client.ts to 751 (an unread start time is waited for and then pins the server: `unread`; legacy gated on `proto`; the Windows start time read again before the signal), socket.ts to 271 (no peer text before the proof, the pre-proof cap, hex nonces), record.ts to 482 (`proto`).
	// Todo #13, R13-F001: socket.ts to 267 (protocol 2: the secret never crosses the wire; the mutual proof with a challenge from each side, the version mismatch answer, `sent` and the hello's own wait on ControlError) and client.ts to 721 (a server of an older package that does not take the handshake is ended by signal: `probe`'s `legacy`, `endLegacy`, and where `ensure`, `restart`, `stop`, and `describe` use it).
	// After the review of 808a555: acl.ts 360 (the link-free walk, the read-back of every file and folder below), client.ts 606 (the denied probe confirmed by a start time, the refusal's start-error.json), socket.ts 220 (the hello proof); devices.ts 95 to 103 (its temporary file created new under a random name).
	// B1 follow-up (R13-F003, the trust gate): client.ts 653 (probe passes the owner gate before it trusts a record; the acl refusal as one helper), winprep.ts 312 (ownerGate remembers a refusal and a failed read).
	// B1 follow-up (the owner read off the event loop, the POSIX uid gate): server-look.ts 191 (an agent's restart is judged by the owner before its record is read), client.ts 657 (`trusted`; the gate and prepare awaited), winprep.ts 392 (the asynchronous runner, ownerGate shared and awaited, the replaced folder), record.ts 419 (prepareSlot waits for an asynchronous gate; uidGate), cli.ts 308 (`up` judges the owner before it reads the record).
	// After the review of 873be01 (b1f-F001 to F009): server-look.ts 196 (a look in flight after shutdown does nothing; logs gated), client.ts 670 (`trusted` reads the record first, `passGate`, the timeout as a wait), winprep.ts 422 (one read for three paths, `GateTimeout`), record.ts 461 (the link-aware uid gate, root, `O_NOFOLLOW`, prepareSlot gate on POSIX), cli.ts 322 (logs and the error JSON behind the gate).
	// client.ts (what a session or the CLI does to start, restart, stop, and see the server), intercom.ts (the connection through the headless kit), main.ts (the server process), and cli.ts (what cli.mjs runs).
	// Test isolation: server-look.ts 195 (deps.track, each look told to a test that waits for the looks in flight before it removes their folder); client.ts 647 (a real spawn is checked by testguard.ts, which is new, when the context is made and when it spawns). After the merge with the b1 follow-ups: client.ts 685, server-look.ts 204.
	// Re-check 4: record.ts 468 (the record's file identity), client.ts 677 (trusted binds content to the judged file), winprep.ts 492 (note hook, identity before protect), server-look.ts 199 (the note told once).
	// Re-check 3 (R3-F001, R3-F002): winprep.ts 487 (remember by the pre-read identity; an open folder is protected by the gate and held when that fails).
	// Re-check of the b1f fixes (R2-F001 to R2-F004): record.ts 463 (the sudo message bounded to pi's folders), client.ts 674, winprep.ts 463 (the folder remembered only when closed; a vanished path is a failed read), cli.ts 330 (logs gated once the folder exists).
	// GUI in the sb server (B2): main.ts 414 (the GUI host started between the intercom id and ready, stopped with the server, the record's gui block and its stopped mark), cli.ts 337 (`up` starts the GUI too; `status` says the GUI and remote state), client.ts 644 (the gui-stopped state, remote in status). guihost.ts (the server's side of the GUI) is a file of its own. After the merge with B1f: server-look.ts 230, client.ts 687, cli.ts 361.
	// B3 (the link holder moves into the server): main.ts 383 to 412 for the `link` request, the holder built after the first connection with its first look awaited, its stop at shutdown, and its status. After the merge with B2: main.ts 444 (the GUI link asks the holder in process: inProcessLink).
	// B4 review fixes: record.ts 391 to 395 (renameInto, shared by towerstore), towers.ts to 496, towerstore.ts to 217 (the queue cap, the cached top, purgeAll), towerclient.ts to 70.
	// Unreleased (sb server B4): towers.ts (the tower service: identities, tabs, tokens, conversion), towerstore.ts (service.json, the queue, the opener's ledger), towerruns.ts (the `towerRuns` switch), towerclient.ts (how a session asks for a tower); version.ts gains serverCli; main.ts the service's wiring and its four commands.
	// Review fixes of the 0.46.0 integration (SBIR-F002): testguard.ts 115 (`guarded` notes the start time WMI told and lets a note with none go at `release`; a pid of 0 is never noted).
	// Test isolation merged with B4: server-look.ts 197 (deps.track and the reach context); client.ts 647 (testguard.ts, new, checks a real spawn).
	// Unreleased (R-F002): client.ts 697 to 698 for the ready server's record read again in waitReady.
	// Unreleased (sb net stand-in): main.ts 593 to 606 (prompt-poll, prompt-leave, prompt-gone, run-boss, the present flag of tower-event), cli.ts 362 to 382 (the prompt command), towers.ts 698 to 724 (the standing pane's wiring); standing.ts (the standing pane's look, new) and src/towerprompt/ (the prompt program: source, serversource, prompt, messages, new) have no figure in the spec.
	// Windows renew review 3 (RV3): towers.ts 765 to 768 (closable takes the pane's own shell by shell_pid and keeps an empty or unreadable foreground; a server stop after the record moved keeps the new tab).
	// Windows renew review (RV2): towers.ts 730 to 765 (renew closes the standing pane only when it holds a shell or the run's own pi, renames a tab that keeps panes, refuses a pi typed in meanwhile, and gives up when the service was closed).
	// Windows pane after a forced kill (B6 VM pass): towers.ts 698 to 730 (renew: a fresh standing pane for a service whose pane a signalled pi left unusable), main.ts 593 to 595 (a stop waits for its runs' decision).
	// Unreleased (sb server B6, VM pass fixes): towers.ts 835 to 839 (a tokens report to a pane or workspace that is gone is logged as tokens-dropped, not as an error).
	// Unreleased (sb server B7, VM findings F1/F3): towers.ts 859 to 878, desk.ts 122 to 125, towerclient.ts 74 to 76 (the base `up --dir` just made counts as a fresh shell when the server can see it so, and replaces a service left for the id of a lost workspace).
	// Unreleased (sb server B6, VM round 2): towers.ts 856 to 857 (the pane a resident tower hands over counts as fresh; a held service starts again when the boss's program in the pane has ended).
	// Unreleased (sb server B6, VM round 2): runmode.ts 427 to 487 (a pane-role answer past the bound is waited for: a late hand answer becomes the hand run, a late none the normal session, a late quit quits, no answer stays plain, a stale claim is released) and session.ts 205 to 207 (the session start is a function, run at once or after the late none).
	// Unreleased (sb server B6, VM fixes 8, docs/specs/2026-10-26-sb-backend.md): runmode.ts 487 to 521 (the process-wide resident mark, the pane-role ask carried across a switch, its release at a quit), session.ts 207 to 209 (a pi that never became a normal session leaves the standing pane open), towers.ts 857 to 859 and towerclient.ts 70 to 72 (the resident's pid rides the hand-over).
	// F10 after Herdr comes back (sb server B7 VM recheck, case 6): towers.ts 859 to 921 (a service proves its seat before it types, marks, or wakes a run in the pane: `prove`, `unseat`, the stranger branch of the reconcile and of an ask, `lose` touching nothing of a stranger, the glyph given to a converted tab); the rule itself is typegate.ts `seatGate`.
	// T3 review fixes: towers.ts 797 to 835 (the memory wiring: a wait is marked answered only for a sender the net shows in this workspace, the expired waits a brief showed are marked at the run's first poll, the memory summary).
	// Keep the token (D27): record.ts 472 to 474 (`readOwnedText`, the owned, link-refusing read that gui-secrets.json uses).
	// Keep the token review (RVD27-F002): cli.ts 382 to 390 (a fatal JavaScript error makes the server leave with code 1; the handler itself is fatal.ts); 390 to 391 (RVD27C-F005: the handler's closure one statement per line).
	// Merge of B7 into the type gate: towers.ts 921 to 942 (B7's `justMade` claim and its use in `openFor`, feeding `adopt`'s fresh mark).
	// Unreleased (sb server B7, desk): desk.ts 104 (new: Herdr's pi integration, the home base in desk.json, desk.lock), cli.ts 391 to 433 (the `integration`, `base` and `tower` steps of `up --dir` and their flags), towerclient.ts 72 to 74 (the ask's own time limit).
	// B7 review fixes (RVB7-F001 to F007): record.ts 474 to 478 (`takeLock` takes another lock's files and age: desk.lock), desk.ts 104 to 119 (the lock through `takeLock`, the base matched to its record, the folder from Herdr's status line), cli.ts 433 to 440 (the base kept or replaced, the Herdr calls bounded by `--timeout`).
	// B7 second review (RVB7B-F001 to F003): desk.ts 114 to 122 (the base matched by its label or a pane in its folder; the Windows case-folding note).
	// Seat review (RVSEAT-F001 to F004): towers.ts 942 to 1007 (the proof is for a terminal and asked of a listing at each act: `holds`, `proven`, `herdrChanged`; `lose` voids the seat; the claim goes through `claimGate`; `recoverPollMs`); the rules themselves are typegate.ts `proofGate` and `claimGate`.
	// Seat re-review (RVSEAT2-D3): towers.ts 1007 to 1009 (the boss's close of the tower tab asks the seat first).
	// Seat re-review 6 (RVSEAT6-F006): towers.ts 1009 to 1011 (a tab that is gone from an unseated service is lost as a stranger's workspace unless the workspace carries the label the service made).
	// Wi-Fi access (L6, docs/specs/2026-10-30-sb-gui-lan.md): lanface.ts (365 after the RVL6 fixes, new) is the overlay of /boss gui lan (the warning, certificate, pairing, and reset faces, the open mark with its renewal and settle rules, the number typed by the boss); host.ts 97 to 149 for the commands and the overlay's seams, boss.ts keeps 80.
	// Wi-Fi access (L5): record.ts 478 to 480 (`lanNotice`, the pair requests that wait while no overlay or tile is open), cli.ts 440 to 441 (`up` warns `lan_off`).
	// Unattended tower (S3): main.ts 623 to 625 (after dialog forwarding) (the import and the `openTower` seam of the link holder; the Herdr work is opentower.ts, 60, new).
	// Unattended review fixes (ut-s6): main.ts 663 to 676 (the unit status is read per team with its project and share, labels and monitor commands scrubbed, the openTower seam passes the home and agent folders, the forwarder and timer start only while the start is still going, and a seam that watches the runs no longer replaces the reporter's signal).
	// Todo #13 round 5 (R13e): client.ts 813 to 829 (a timed-out hello waits for the start time, a held verdict on a cached time is read again on Windows, a dead pid is forgotten, `heldError` is the one predicate `serve` shares, the remedy commands and the legacy warning reworded), server-look.ts 240 to 246 (the held-server notice), main.ts 610 to 612 (the `endpoint` test seam), cli.ts 445 to 446 (serve calls `heldError`).
	// Todo #13 round 4 (R13c-F001, F002; the R13d rule that no start and no `stopped` mark comes while a process the record names runs and does not answer): client.ts 751 to 813 (`settleLegacy`, `endLegacy` that says whether it signalled, `assertNoOwner` and `markStopped`, `heldText` with the command that ends the process, `decide` keeps a running silent server), cli.ts 441 to 445 (`up` and `serve` say what was left alone), socket.ts 271 to 275 (no byte of an unproven peer in an error), towerclient.ts 76 to 78, server-look.ts 238 to 240 and startof.ts 140 to 142 (the limit of a read, exported).
	// Quit tower for the server's own tower (fix/tower-close): towers.ts 1011 to 1015 (`stateOf` and `owns`, which the page's tower panel reads: a service that waits for a resident is no tower on the page, and a service identity is ended, not asked).
	// Windows ACL, an elevated token's folder (fix/win-acl-admin): acl.ts 398 to 402 (the script takes the folder's other explicit grants off by SID), winprep.ts 492 to 509 (the same after the native protect call, in `secure` and in the gate's `shut`, and the identity re-check after the last read-back); strays.ts (new: which grants, and the icacls call) has no figure in the spec.
	// Towers republish their order on workspace events (fix/tower-order-republish, TO-F001..F005): towers.ts 1015 to 1056 (the debounced, chained republish and its dirty rerun).
	// Head tower H1 (docs/specs/2026-11-04-head-tower.md): the head is a service of kind `head` in the tower service, so towers.ts 1056 to 1101 (the kind branches of the tokens, the seat, the loss, the adoption and the retirement; the head's own opening is head.ts, 122, new), towerstore.ts 267 to 282 (the head's folder binding and its purge), record.ts 482 to 485 (`headId`, `headName`).
	// Head tower H1 review fixes (HH1-F001 to F006): towers.ts 1101 to 1106 (the stranger's id is refused at adoption, the head's constant key for the memory request, no opener or `close-main` channel for the head, no main opened in its workspace, and the late write of a look that lost its service; the refusal of a message moved to head.ts), towerstore.ts 282 to 287 (the record's folder by its kind, `HEAD_KEY`).
	// Head tower H3 (docs/specs/2026-11-04-head-tower.md): main.ts 676 to 680 (the `head-*` control commands go to headcmds.ts; the status row carries the head, the GUI host is given the head seam).
	// Worker process hygiene (sb procs fix round 2): procs.ts 403 to 479 for the held-panes-unknown deferral and its bounded retry, the hello refusal of protected pids, the safe save, and the workspace look at each pane event.
	// tsx from its ESM entry (fix/tsx-esm-entry): intercom.ts 102 to 120 for findTsx reading tsx's exports map (the CommonJS entry breaks tsImport on Node 22.22.x), its two distinct errors, and the Node version in a failed load.
	// Final-gate fixes: procs.ts 479 to 485 for the Herdr-server test of the hello refusal and the other-pane foreground refusal.
	// Worker process hygiene (sb procs T2, after its review): the owner registry is procs.ts (403, new), its socket ops and wiring procsops.ts (82, new), the cli command procscli.ts (32, new); main.ts keeps seven lines of it (the import, the option, the variable, the ops hook, the start call; 676 to 682), cli.ts eleven (usage, the flag table, the `sub` word and its check, the case; 446 to 457).
	// Merge of origin/main (0.57.0, process hygiene) into the head tower: main.ts is 686 (main's 682 plus the head's 4), cli.ts 457 (main's figure), and the row keeps the procs files' entries.
	for (const [name, max] of [["record.ts", 485], ["log.ts", 135], ["version.ts", 28], ["acl.ts", 402], ["socket.ts", 275], ["client.ts", 829], ["intercom.ts", 120], ["main.ts", 686], ["cli.ts", 457], ["winprep.ts", 509], ["breakaway.ts", 251], ["testguard.ts", 115], ["towers.ts", 1135], ["towerstore.ts", 287], ["towerruns.ts", 28], ["towerclient.ts", 78], ["desk.ts", 125], ["procs.ts", 485], ["procsops.ts", 82], ["procscli.ts", 32]] as const) assert.ok(count(`src/server/${name}`) <= max, `src/server/${name} has ${count(`src/server/${name}`)} lines`);
	// The page: the files the spec budgets one by one, then this round's own figures (no figure in the spec): the focus views, the overlay
	// layer (alert spotting and the stack model in the map's chunk, the layer's DOM and tiles in a chunk of their own), the dev-only demo, and everything else.
	// 0.18.1 raised mirror.ts to 154 for embed, a terminal shown inside the session view instead of a tile.
	// 0.20.0 raised chat.ts to 269 for an entry's images as thumbnails (thumbs) that open the lightbox (gui/lightbox.ts, 34, loaded on the first open),
	// and views.ts to 326 for the session's queue under the chat (drawQueued).
	// 0.20.0 raised ask.ts (src) to 127, dialogs.ts to 220, and bridge.ts to 237 for the queue each bridge relays: what it saw typed while its agent works, until a turn takes it.
	// 0.19.0 raised layer.ts to 183: a finished alert shows no Later.
	// 0.23.0 to 212 for the finished list: the HUD's Finished button and its popover (a row per finished unit that opens its comms and clears it, and Clear all), apart from the HUD alert.
	// 0.24.0 to 232 for a dialog's Enlarge (the wide dock, kept per browser); mirror.ts from 154 to 175 for a desktop's keyboard into the focused
	// terminal (the hidden text box and its key, input, composition, and paste listeners, the note, the glow) and Fit width going to the bottom;
	// keypad.ts from 60 to 124 for that keyboard's key and chord map, typed text and pastes, and its write queue (one write at a time, 130 ms
	// apart, typed characters joined, a refusal or a confirm dropping the rest).
	// 0.19.0 raised views.ts to 313 for the session's todo list (drawTodos): the count and the task in progress, unfolded to every task.
	// 0.18.2 raised views.ts to 300 for the close button in the comms header (a phone has the profile far below) and its channel state as a dot.
	// 0.18.1 raised views.ts to 295 for the session view's two modes, its chat or its pane's terminal, one at a time (setMode, and a terminal an alert asks for).
	// 0.17.3 raised chat.ts to 254 for the motion of a message that just arrived or went out, kept across the redraw its result brings.
	// 0.17.2 raised views.ts to 267 for the location bar: a subagent under its launcher's level, and the middle levels folded into "…" on a phone.
	// 0.17.0 raised views.ts to 259 for the close buttons of a base, its squads, and a unit (a subagent's is its launcher's to close).
	// 0.25.0 raised views.ts to 347 for the monitors bar under the todos (each monitor's state, exit code, line count, and last line), chat.ts to 270 for its type on a unit.
	// 0.26.1 raised chat.ts to 274 to leave a log where the finger holds it, and while its fling coasts, instead of pulling it to the bottom.
	// 0.27.0 raised chat.ts to 275: the log's end and top are read off two sentinels that watch only while it scrolls (no geometry is read per scroll event), and the lit entry restarts without a layout read.
	// 0.25.1 raised views.ts to 348 for a phone's comms scrolled into view as the session opens, so its composer is on screen.
	// 0.27.0 split views.ts (348) into its coordinator (90) and the modules it calls: the Scene they read (scene.ts), the unit token (tokens.ts), the location bar and
	// the entrance (nav.ts), the workspace route (workspace.ts), the dossier (dossier.ts), the session's comms (session.ts), and the bars above its composer (bars.ts).
	// Unreleased raised workspace.ts to 60 for the tower's subagents tethered under it.
	// Unreleased raised session.ts to 116: the comms head carries the unit's mark, so it glows while the unit is commanding.
	// Unreleased raised scene.ts to 38 for `closed` (a channel is closed when its session left the net or a finished subagent's pi exited) and composer.ts to 191 (a closed channel's box is disabled).
	// Unreleased raised scene.ts to 41 and session.ts to 121: a tower's comms head carries "+ Main", the map's opening button aimed at the tower's base.
	// Unreleased raised layer.ts to 250: fit() watches a gauge of the work's width, not the work, whose height changes inside the map's packing report.
	// Unreleased raised session.ts to 124, bars.ts to 85, and composer.ts to 294: the queue's Edit (its bar, its wiring, and the composer's take-back with its id, the reply stored for a composer that is gone, and the rows opened per session).
	// Unreleased raised composer.ts to 301: takeWhy, a take-back's refusal worded in the page's language.
	// Unreleased raised composer.ts to 302 (sb server B5): `wakes`, the tower the composer wakes (its placeholder, and no follow-up or stop).
	// Unreleased raised chat.ts to 283, session.ts to 135, dossier.ts to 50, workspace.ts to 61, and composer.ts to 303 (sb server B5, GUI visual pass): the tower service's words and notices come from towermodel.ts and towerturns.ts, and the views call them (a run's
	// intercom turns shown as incoming, the Terminal tab's sentence for a tower with no run, the notices again in the comms, the state in the head and the dossier, the server queue's label, a held tower's placeholder).
	// Review RV-F001: chat.ts 283 to 284 for the boss turn of a service tower shown without the server marker line.
	// GUI fix pass (sb server B6): chat.ts 284 to 301 (a run's events read by their kind: the YOU bubble and the notice shared by every incoming message, the labels, the folded header, the standing-by sentence), session.ts 135 to 139 and dossier.ts 50 to 51 (an ally run's comms: its header, state, and chips), workspace.ts 61 to 66 (the queue chip, the chips, and the notices of the workspace view).
	// GUI fix pass 2 (sb server B6): chat.ts 301 to 307 (the intercom label with its id and origin, the boss bubble only in a service run), scene.ts 41 to 47 (channelOf: the read-only channel of an ally run), composer.ts 303 to 305 (typable).
	// Ended bar (sb server B6): composer.ts 315 to 327 (barOf, and draw swaps the composer for the one-line bar).
	// Phone terminal keyboard (sb server B6): mirror.ts 175 to 198 (the sink, the Keyboard button, beforeinput keys, the sentinel) and session.ts 142 to 147 (the composer lets go of the focus on the Terminal tab).
	// Phone layout (step 4): bars.ts 85 to 99 for the queue's fold row (foldQueue, mountQueueFold); session.ts 147 to 150 for the head's `⋯` menu (a tower's + Main and Quit tower, flagged data-tower) and the queue's fold row (mounted and drawn with the other bars).
	// An answer that needs the terminal opens it (feat/answer-opens-terminal): gui/ask.ts 185 to 188 (the accepted outcome's `then` goes to openThen), gui/mirror.ts 198 to 200 (`open` takes the keyboard for a pane tile), and gui/terminalthen.ts (21, new: the one shared call).
	// Zen lines (feat/zen-lines): zenlines.ts 90 to 139 (+49): 24 more sourced lines at two lines each (a source comment and the entry), the `ja` field, and its element in `mountLine`.
	// Zen Z4 (ink and motion): i18n.ts 50 to 55 (`setLocale` and `localeNames`, shared by the settings menu and the Zen menu), zen.ts 220 to 230 (the corner, the dissolving card, the empty state's line), zentypes.ts 37 to 46 (the menu, full-screen, and line deps); zenlines.ts (the 14 sourced lines and their deck), zenmenu.ts (the corner menu), zenfs.ts (full screen and the Home Screen hint), and soundprefs.ts (the Sound switch's and Volume's keys, shared with notify.ts) are new.
	// Zen polish: keypad.ts 135 to 136 (the reason by token, the pair's span), zen.ts 272 to 274 (`fade`, `shown`).
	// Zen terminal layer: zen.ts 265 to 272 (the layer's mount, the guards that keep the terminal's keys from the pause, `terminal`), zentypes.ts 49 to 53 (`Term`, the `embed` dep), mirror.ts 200 to 202 (`embed` takes `keys` and `end`); zenterm.ts (the layer: the host, the button, Esc, the two auto-returns) is new.
	// Zen Z4 feedback: zen.ts 230 to 265 and zentypes.ts 46 to 49 (the ripples dep; Esc's facts and the quiet line, the card's two boxes and their glide, the draft's hold, the ripples' mount), ask.ts 185 to 189 (`cancel()`, the card's Cancel pressed by Esc), zenmenu.ts 90 to 96 (the Auto row and the choice-based marks); zenkeys.ts (Esc's table), zensize.ts (the card's glide), zenripple.ts (the ripples), and viewface.ts (what a view move does to the page's face) are new.
	// Head tower H5 (docs/specs/2026-11-04-head-tower.md, the Zen strip): zen.ts 353 to 374 (the strip's mount, the history as a companion with its way back, the draft's hold, Esc's head row, Enter's talk key, the palette's three entries); the rest is zenhead.ts and headlines.ts (new).
	// Zen terminal fix round (ZT-F001 to F003): mirror.ts 202 to 207 (the sink says what its pad may do, `entered` for the pad's Enter, a gone pane's refused attach ends it, Shift+Esc lets the sink go); keypad.ts 131 to 135 (`entered`); zenterm.ts 92 to 111 (the Enter rule, the tower's sentence, the dead pad's Esc, the phone's focus).
	// Terminal card T1 (a move, no behavior change): the connection core leaves mirror.ts for mirrorconn.ts (82, new: attach queue, hello, park, stale check, refusals and the end, the rows the frames set; the tile and `embed` are views of it, and `watch` is the third), so mirror.ts goes 207 to 190.
	// Terminal card T3: gui/cardmodel.ts (47, new, pure: tail, secretPrompt, the mask, cardState, stepRule; the spec allows 90). Nothing imports it yet, so no bundle changes.
	// Terminal card T2: gui/keywriter.ts (69, new: the writes of a terminal's keys, taken from keypad.ts, which goes 136 to 87; the spec allows 70); mirrorconn.ts 82 to 84 (`taken`).
	// Terminal card T4: gui/termcard.ts (121, new: the card's DOM and its sends; the spec allows 160), keywriter.ts 69 to 70 (the refusal reaches `failed`).
	// Terminal card T5: gui/stepslot.ts (63, new: the dock's slot), gui/zenhost.ts (59, new: what Zen's layer host holds), termcard.ts 121 to 129 (the lazy attach for a held tower, the optional ×), layer.ts 253 to 262 (the slot, `kit`), zenterm.ts stays 111 (card mode and full mode, with the host's drawing in zenhost.ts; the idle bookkeeping is gone), zen.ts 274 to 277, mirror.ts 190 to 192 (`id`), zentypes.ts 53 to 61 (`TermKit`), keypad.ts and mirrorconn.ts lose `entered`.
	// Zen Z6 (music): zen.ts 276 to 279 (the music controls in the corner, shown, hidden, visible, and Esc), zentypes.ts 61 to 64 (the `music` dep); zenmusic.ts (the two-element cross-fading player) and zenmusicbar.ts (the note, the track list, the switch's states) are new.
	// Terminal card T7: gui/confirmbar.ts (12, new: the confirm pair, once for the pad's note and the card's status; keypad.ts 87 to 80, termcard.ts 129 to 123) and gui/termwords.ts (18, new: the refusals of a terminal's keys and mirror by the server's code, and the mirror's ended reasons, in the page's language; keywriter.ts 70 to 71).
	// Terminal card review fixes (TC-F001 to F008): termcard.ts 123 to 148 (the retry from the button with its backoff, the stopped card's silence, the focus and mask rules), mirror.ts 192 to 193 (`watch` gives `retry`), termwords.ts 18 to 19 (four codes).
	// Z-D14 (a long lone question is set as text): gui/ask.ts 194 to 196 (LONG_Q and its line).
	// A wait for the boss is an alert (docs/specs/2026-10-26-sb-backend.md, Tower memory): layer.ts 260 to 261 (a wait's dialog is waitpanel.ts's, one line to hand it over; the skipped transmission read shares an existing line). zen.ts 353 to 360 (a wait's card: its mount and the two places that read the unit's history skip a wait). alerts.ts and overlay.ts 159 to 161 (the import of waits.ts and its one call in `alertsOf`).
	for (const [name, max] of [["router.ts", 80], ["chat.ts", 339], ["markdown.ts", 180], ["views.ts", 99], ["scene.ts", 55], ["tokens.ts", 24], ["nav.ts", 46], ["workspace.ts", 66], ["dossier.ts", 52], ["session.ts", 165], ["sessionfacts.ts", 10], ["bars.ts", 99], ["lightbox.ts", 34], ["layer.ts", 261], ["askkeys.ts", 80], ["composer.ts", 327], ["ask.ts", 196], ["terminalthen.ts", 21], ["answer.ts", 16], ["mirror.ts", 193], ["mirrorconn.ts", 84], ["keywriter.ts", 71], ["termcard.ts", 148], ["confirmbar.ts", 12], ["termwords.ts", 19], ["stepslot.ts", 63], ["zenhost.ts", 59], ["cardmodel.ts", 49], ["keypad.ts", 80], ["doc.ts", 108], ["i18n.ts", 55], ["slash.ts", 63], ["zen.ts", 381], ["zenquestions.ts", 159], ["zentypes.ts", 70], ["zenterm.ts", 111], ["zenlines.ts", 139], ["zenmenu.ts", 96], ["zenfs.ts", 56], ["zensound.ts", 140], ["zenmusic.ts", 116], ["zenmusicbar.ts", 178], ["prefs.ts", 41], ["tabicon.ts", 10], ["intel.ts", 15]] as const) assert.ok(count(`gui/${name}`) <= max, `gui/${name} has ${count(`gui/${name}`)} lines`);
	// 0.28.0 to 185 with the answer keys' hooks into gui/ask.ts (the focus on the first option, the textarea). 0.28.0 raised gui/ask.ts from 156 to 175 for the secret panel: the masked field with Show and Hide, Submit, the way back to the terminal, the unsupported-remote notice, and a value that leaves with its one request.
	// 0.10.0: the page's text comes from Paraglide's messages (gui/messages), which raised chat.ts, views.ts, layer.ts, ask.ts, mirror.ts, and doc.ts by one
	// line each for the messages import; the strings replaced in place. gui/i18n.ts picks the locale (the menu's choice, the browser's languages with
	// Chinese by script) and translates index.html's static text: 50 lines, no figure in a spec.
	// 0.8.0 raised views.ts from 245 to 251 for the documents: the dossier's list, a document that arrives opening beside the comms, and the show_doc
	// card's lookup for Open beside. The document tile and its rules (gui/doc.ts, 0.8.0) had the Phase 3 plan's 80; it takes 107, 27 over that figure:
	// beyond the tile, its frame, and revisions it holds the arrival rules (by display name, units that left forgotten), the show_doc path match,
	// the dossier's list, a load of an older revision that finishes late, and a failed load that retries when the tile shows.
	// 0.5.0 raised views.ts from 240 to 245 and layer.ts from 150 to 165 for the read-only question panel (gui/ask.ts) in the session view and
	// in alert dialogs, and layer.ts also for raising a dialog that peeks out beneath the top one.
	// The composer's figure was the spec's 120; 0.5.0 raised it to 125 so a send in flight outlives a composer the route replaced (review R-1);
	// 0.5.1 to 165 for the note a send leaves when no composer is there to say it (a refusal's reason, an edit of text that already went) and the three pure rules around it.
	// 0.5.1 raised layer.ts from 165 to 175: dialogs of units that left the net, one queue count in the header and every dialog, a click that really hit a control;
	// 0.7.0 to 180 for the terminal tiles: a tile's own header icon, a tile that hears it closed (by its × or pushed out), and the mirrors mounted with the layer.
	// The terminal tile (gui/mirror.ts, 0.7.0) has the Phase 3 plan's 130 plus 10: a hidden tab parks its mirrors and a stale check runs only while a tile shows;
	// plus 5 for the key pad's hook (task 4: the pad's type, and its update when the mirror goes live, hidden, stale, or ends). The pad (gui/keypad.ts) has the plan's 60.
	// The answer panel's figure was 130; 0.6.0 raised it to 140 for a panel that belongs to its dialog, so the net's updates leave what the user picked, typed, and noted;
	// 0.7.0 to 155 for Show terminal on a read-only panel (not a secret's).
	// 0.6.1 to 152 for a panel refused as busy that answers again once the other answer was refused, an outcome that lingers six seconds from the
	// unit's leaving instead of from the latest update, and a focus that comes back to the control a disconnect or a Send on its way disabled (unless the user went elsewhere).
	// The comms log's scroll rules (pinned to the end, reaching an anchor) are pure and live beside it.
	assert.ok(count("gui/follow.ts") <= 50, `gui/follow.ts has ${count("gui/follow.ts")} lines`);
	// Unreleased (project trust): layer.ts 250 to 264 (the trust question's dialog: its panel in place of the transmission, no history read for it), deploy.ts 124 to 139 (the trust step's label and inline question, the give-up that waits, the openings
	// this page runs), spawn.ts 59 to 60 (the answer route handed to the panel), and the question's own module (gui/trust.ts, 73: the panel, its choices, outcomes, and the line where the agents run).
	assert.ok(count("gui/trust.ts") <= 74, `gui/trust.ts has ${count("gui/trust.ts")} lines`);
	const overlay = sum("gui", ["alerts.ts", "overlay.ts"]);
	// 0.5.0 raised it from 110 to 115: dialogs the user did not open go beneath the top one, and alerts carry the question;
	// 0.5.1 to 125 for the queue count in words, a dialog whose unit left the net, and redraw.
	// 0.23.0 to 136 for finished units in a list of their own (the HUD alert opens questions and errors only, resolve clears one or all) and a
	// finished alert that clears itself once its unit's pane closed. 0.24.0 to 139: also once pi-herdr-agents recorded the subagent's run done.
	// 0.25.0 to 148 for an alert of a failed or quiet monitor: its own key, `unit` (and unitOf) for the unit it belongs to, and its note.
	// Unreleased to 157 for the alert ranking: only a unit waiting on the user (or with a dialog pending) is prominent; an error and a failed monitor are notices, and rankOf reads the alert.
	// Unreleased (project trust) to 162: a trust question as an alert (alerts.ts: `trust` on Alert, the openings this page runs, one alert per folder and digest).
	// Views-core R1 to 159: the walk over a net's units and the ranking left alerts.ts for gui/units.ts (3 lines), which the page's total takes.
	assert.ok(overlay <= 161, `the overlay model has ${overlay} lines`);
	const demo = sum("gui", ["fixture.ts", "demo-chat.ts", "democard.ts"]);
	// Unit status and notices (S5) to 374 (measured, +4 over 370): fixture.ts gained the unattended device's ally base with its unit-status, a notice, and an ended dialog card.
	// 0.5.0 raised it from 160 to 165 for a demo question and a demo secret; 0.6.0 to 170 for a demo robot_hand selector and questionnaire that answer;
	// 0.6.1 to 174 for a demo tool call whose arguments show cut (with the whole of them for "show all arguments"), an answerable dialog that stays
	// until it is answered, and a toolbar that folds to a tab in the margin on a phone.
	// 0.7.0 to 190 for a demo terminal: a pane whose screen changes every second while a terminal tile shows it, and the stream's hello.
	// 0.28.0 to 191 for a demo secret that answers (n % 4 == 1) beside the one that only waits in the terminal.
	// Unreleased (comfort) to 197: the server's activity tracker over each demo snapshot, half an hour of history played at the start, tools that vary, and todo lists.
	// Unreleased to 199: the demo's folder picker and deploy stand in for the server (gui/demo-open.ts, its own figure), installed by the fixture.
	// T4 recheck round 2 raised composer.ts to 315 (placeholderOf, wakeOf, the event run's own read-only reason); fixture.ts gained the "inrun" state (boss inside an event run).
	// T4 recheck round 2 to 240: the "inrun" state of the harbor tower (the boss inside an event run).
	// T4 to 231: the harbor tower in each state of the boss conversation (`?tower=<state>`), with the runs' times matching the demo history.
	// fix/tower-close to 243: the demo restores itself after a drop or silence (the overlay covers its toolbar).
	// Zen layer (Z3) to 262: the `?zen=` states (zenState) and the trust answer the demo settles.
	// An answer that needs the terminal opens it (feat/answer-opens-terminal) to 270: the demo's robot_hand button (billing-main waits on the selector) and the `then` its answer returns, read from the chosen choice's `next`.
	// Zen feedback round to 265: the toolbar's server-view button and the stream's `view` event (the demo's stand-in for `/boss gui view`).
	// Both increments summed (answer-opens-terminal +8, Z4 feedback +3, and the merged toolbar row +1): 274.
	// Zen polish to 281 (+6): the demo's key pad answers Enter and Esc with a confirm and Tab with a refusal (PAD_REPLIES), so the confirm bar and a refused key can be looked at.
	// Terminal card T6 to 360 (measured 314): gui/democard.ts (66, new: the card's scripted terminal for `?card=<state>`) and fixture.ts 239 to 248 (the script's hooks, the opening, the Run choice; the `?zen=terminal` timer is gone).
	// Zen Z7 to 370 (measured 366): the `?zen=history|palette|pause` key presses and `?music=<n>` with the fixture's `api` (the demo's music folder); the real build did not grow.
	// Z-D12 and Z-D14 to 375 (measured 371): `idle` stores billing-main as the session last written to, `alone` clears it, and `?zen=long` shows one long multi-select question (LONG).
	// Merge of feat/link-unattended with 0.55.0 (Zen Z-D12 to Z-D16): 379 measured, the unattended device's units, notice and ended card beside Zen's `idle`/`alone`/`long` fixtures.
	// A wait for the boss (`?wait=fresh|stale|both`) to 395 (measured, +16): the tower's memory summary with the waits, and the stand-in for the memory route's drop.
	// Merge of the head tower into main (0.58.0): 403 measured, the wait's `?wait=` states beside the head's `?zen=head*` states.
	assert.ok(demo <= 403, `the demo fixture has ${demo} lines`);
	// Head tower H5 to 387 (+3 over 384): the strip's `?zen=head|head-open|head-history` states (the quiet net, the Enter and H presses, the draft), and a message to the head answered with its working mark (demo-head.ts holds the words).
	// 0.13.0 raised views.ts to 253 for the base view's two opening buttons; the opening tile (gui/spawn.ts) has its own figure below.
	// 0.15.0 raised composer.ts to 190 for files: pasted, dropped, or picked, each uploaded and its path put in the message.
	// 0.15.0 to 254 for the squads' + Member buttons, and gui/spawn.ts to 68 for the new base, member, and squad member tiles and the button reader.
	// Unreleased to 58: the folder picker moved to gui/picker.ts, the opening tile keeps its form (name, first message, open) and the deploy panel, from 75 for the deploy panel taking the form while a unit opens (the panel itself is gui/deploy.ts, 114, with the demo's stand-in server in gui/demo-open.ts, 35).
	// Unreleased deploy.ts to 124: the timeout measures silence, a late ok still shows ready, and closing the tile stops it.
	// Unreleased (settings check) deploy.ts to 142: the import of gui/refusal.ts and the refusal worded from the server's facts on both failure paths.
	assert.ok(count("gui/deploy.ts") <= 142 && count("gui/demo-open.ts") <= 46, "the deploy panel and its demo stay small");
	// Unreleased: the folder picker the opening tiles share is Finder's column view: its state (gui/folders.ts: the columns of the selected folder's levels, arrow keys, back and forward, new folder) and its drawing (gui/picker.ts: toolbar, shortcuts, columns, path).
	// Unreleased (desk remainder, S10) raised picker.ts to 101: the Choose… button of the desk shell's native folder dialog, which feeds the picker's own listing.
	assert.ok(count("gui/folders.ts") <= 126 && count("gui/picker.ts") <= 101, "the folder picker stays small");
	assert.ok(count("gui/spawn.ts") <= 60, `gui/spawn.ts has ${count("gui/spawn.ts")} lines`);
	// The phone pairing tile and the write helper it shares with the composer (0.5.0, no figure in the spec).
	const pairing = sum("gui", ["pair.ts", "post.ts"]);
	// 0.15.0 to 55 for post.ts sending a file's bytes to a session's upload. Unreleased to 58: the paired devices under the code (devices.ts, 31 at most, its own figure).
	assert.ok(count("gui/devices.ts") <= 31, `gui/devices.ts has ${count("gui/devices.ts")} lines`);
	// Wi-Fi access, the page (L7, docs/specs/2026-10-30-sb-gui-lan.md): the tile got its two tabs (pair.ts 57 with the tab buttons, the per-tile surface id, and the tab switch; post.ts gained `get` for the poll of `lan/pending`), so the pair
	// figure is 74; the Same Wi-Fi tab (the risk and the turn-on, the waiting requests with the number field, the certificate step, the pairing QR with its codes and the address toggle) is lan.ts, 163, and the QR drawing moved out of pair.ts into qr.ts, 16.
	// Review RVL7 (fixes F001 to F011) raised the pair figure to 85 (the tabs' ids, panels, and arrow keys; the tile opening on the Wi-Fi tab) and lan.ts to 232 (rows and live regions drawn by their id and not again, the codes worded in the page's
	// language, one decision at a time, a link for each certificate file, the name offered only while the server answers to it); qr.ts takes the label; lanwait.ts, 23, is the header's notice for a request that waits while the tab is closed.
	// Settings page (step 5) to 86: `select`, the way the page moves an open Phone section to its Same Wi-Fi tab (the header's waiting-request notice).
	assert.ok(pairing <= 86, `the pairing tile has ${pairing} lines`);
	assert.ok(count("gui/lan.ts") <= 253 && count("gui/qr.ts") <= 17 && count("gui/lanwait.ts") <= 23, "the Same Wi-Fi tab, the QR drawing, and the waiting notice stay small");
	// Unreleased: the answer form's keys (gui/askkeys.ts: arrows, Tab, Enter, and Space between options, questions, own words, and Send, one tab stop per group) have a figure of their own,
	// and layer.ts went to 249 for the dialog that takes the focus on its first option instead of Open comms (4 lines).
	// Unreleased: the dialogs' keys (Space opens the next alert, F enlarges the top dialog; gui/hotkeys.ts: the routing and its listeners) have a figure of their own,
	// and layer.ts went to 245 for the hotkey entry both keys reach (13 lines); hotkeys.ts went to 50 for the pointer-focus tracking that lets Space through on a control the mouse left focused.
	assert.ok(count("gui/hotkeys.ts") <= 73, `gui/hotkeys.ts has ${count("gui/hotkeys.ts")} lines`);
	// The phone drawer (Unreleased): its gesture rules (swipe.ts, apart from the DOM so they are tested) and the list with its touch wiring (drawer.ts) have a figure each.
	assert.ok(count("gui/swipe.ts") <= 40, `gui/swipe.ts has ${count("gui/swipe.ts")} lines`);
	// Unreleased to 167: a finished subagent's card swiped to the right is dismissed (the card's drag, its release, and quit.ts's dismiss).
	// Unreleased to 172: the drawer's way back to the map and its Dismiss finished button.
	// Unreleased to 194: the tower as a row of two buttons (icon, +), Quit on an idle main, and the way back to the map in the drawer's foot.
	// Phone layout (step 4) to 197: the tower row names its tower and its state (two lines in the row's template, three in its fill).
	// Head tower H4 review fixes 207 to 208: the drawer row carries the news dot.
	assert.ok(count("gui/drawer.ts") <= 208, `gui/drawer.ts has ${count("gui/drawer.ts")} lines`);
	// Unreleased (comfort): the timeline under the stage (gui/timeline.ts: a mark per event of the net's last 30 minutes, placed by its time, named on hover, a link to its unit)
	// and the map's overview in a corner (gui/minimap.ts: shown while the map runs past the window, its frame moved on a scroll) have a figure each.
	assert.ok(count("gui/timeline.ts") <= 42, `gui/timeline.ts has ${count("gui/timeline.ts")} lines`);
	assert.ok(count("gui/minimap.ts") <= 44, `gui/minimap.ts has ${count("gui/minimap.ts")} lines`);
	const shipped = new Set(["trust.ts", "timeline.ts", "minimap.ts", "swipe.ts", "drawer.ts", "router.ts", "chat.ts", "lightbox.ts", "follow.ts", "markdown.ts", "views.ts", "scene.ts", "tokens.ts", "nav.ts", "workspace.ts", "dossier.ts", "session.ts", "sessionfacts.ts", "bars.ts", "layer.ts", "alerts.ts", "overlay.ts", "fixture.ts", "demo-chat.ts", "democard.ts", "composer.ts", "pair.ts", "devices.ts", "spawn.ts", "deploy.ts", "demo-open.ts", "folders.ts", "picker.ts", "post.ts", "ask.ts", "mirror.ts", "mirrorconn.ts", "keywriter.ts", "cardmodel.ts", "termcard.ts", "stepslot.ts", "zenhost.ts", "keypad.ts", "doc.ts", "i18n.ts", "slash.ts", "hotkeys.ts", "askkeys.ts", "towerturns.ts"]);
	const page = sum("gui", names("gui").filter((name) => !shipped.has(name)));
	// 0.8.0 raised it from 540 to 543 for the scroll badge with the count of a unit's documents on its plate (render.ts).
	// 0.10.0 to 554 for the messages: the import in main.ts, render.ts, log.ts, and stream.ts, the locale started in main.ts, and render.ts's role
	// names and the server's fixed status words as messages (a note it does not know shows as it is).
	// 0.11.0 to 558 for main.ts reloading a page whose stream says hello from another build than the one the server wrote into it.
	// 0.15.0 to 578 for the opening buttons on the map: render.ts points a base's and each squad's at + Main or + Member, main.ts opens their tile.
	// 0.17.0 to 598 for the close buttons: render.ts aims a base's and each squad's (aimClose), main.ts confirms and posts every close.
	// 0.18.1 to 612 for the page's own confirm dialog (main.ts) and the terminal an alert opens in its session view.
	// 0.18.2 to 623 for the tab icon's badge (main.ts).
	// 0.20.0 to 631 for main.ts: a closed base or unit's view goes up to what is left (leave), Escape left to an open modal, and each entry's image URL.
	// 0.21.0 to 718 for reminders and sounds: notify.ts (87 lines, the header's switches, notifications, one sound a batch) and main.ts handing it each snapshot's arrivals.
	// 0.23.0 to 748 for the sound panel (notify.ts: on, volume through Web Audio's gain, a try) and the popover placement it shares (render.ts).
	// 0.24.0 to 752 for the demo build (vite.config.ts: GUI_DEMO, the base it is served under, and its own output folder).
	// 0.25.0 to 754 for a failed monitor's note in words (render.ts).
	// 0.25.1 to 755 for main.ts hiding Phone on a paired device's page (pairing is this computer's to start).
	// 0.26.0 to 760 for Quit on each unit of the map (render.ts: its key, name, role, and whether this unit may quit).
	// 0.26.1 to 763 for Quit tower on the map (render.ts: the tower's key and name, shown when it may quit).
	// 0.27.0 to 779 for Quit in one module (quit.ts: the four buttons' labels and data, the confirmation, and the close's aftermath, out of render.ts and main.ts): its header, imports, and exports.
	// 0.27.0 to 827 for the page's idle motion: calm.ts (26: infinite animations rest after 30 s without input), packets.ts (23: the wires' packets as compositor keyframes
	// instead of SVG animateMotion), and `replay` in dom.ts (3: a one-shot animation restarted without a layout read), less what they replaced in render.ts, main.ts, nav.ts, chat.ts, and mirror.ts.
	// 0.27.0 to 831: packets.ts interpolates between curve samples so a packet's pace is even.
		// Unreleased to 833: main.ts mounts the dialogs' keys (hotkeys.ts) and takes the modal selector from it.
	// Unreleased to 835: quit.ts aims a finished subagent's button at Dismiss and posts it without asking.
	// Unreleased to 840: render.ts's `say`, which flags a unit's note red while it only waits on a running monitor.
	// Unreleased to 841: render.ts draws a tower's subagents under its base's header.
	// Unreleased to 852: quit.ts counts the finished subagents and draws the HUD's Dismiss finished button (endedSubs, showDismissAll), main.ts calls it.
	// Unreleased to 853: the commanding mark's HUD figure and glow flag (render.ts), and the packets' live check.
	// Unreleased to 862: main.ts loads the phone drawer (drawer.ts) where there is a touch screen or a narrow window and hands it each snapshot and route; the demo's toolbar gets a drawer button.
	// Then to 863 for the alert ranking (alerts.ts: waiting or a pending dialog is prominent, the rest are notices).
	// Unreleased to 888 for stash and pop on the map (quit.ts: aimStash, showStashed and its Pop buttons, Stash and Pop in the click handler; render.ts and main.ts wire them, and hang the Stashed list under its button).
	// Unreleased (net sidecar) to 891: render.ts holds the agent labels and the badge on the card.
	// Unreleased (comfort) to 901: render.ts packs the bases like masonry (a ResizeObserver spanning each card's rows) and publishes the header's height (--hud) for what sits under it; main.ts names the view on the stage.
	// Unreleased to 1389 (1385 for Straw Link, 4 for the session view's Quit): Straw Link's page code (link.ts: the team settings tile; linkbar.ts: the header's notices and the forwarded confirm; linkmodel.ts: their words and marks; render.ts: the teammates' bases).
	// Unreleased to 906: quit.ts aimSession, the Quit in a unit's comms header (leave exported for its test).
	// Unreleased (settings check) to 1404: gui/refusal.ts (the refusal worded from the server's facts, 12 lines with its import in deploy.ts and quit.ts's Pop).
	// Unreleased (GUI in the sb server) to 1461: gui/server.ts (55: the server panel, a lazy tile) and main.ts (2: the header button, this computer's page only).
	// Unreleased (R-F001) to 1472: the stream's `replaced` state (stream.ts: the look at the page's address, no resume once replaced) and its banner (main.ts).
	// After the merge with 0.46.0 (the stream's `replaced` state and its banner) the page is 1498.
	// Unreleased to 1486 (sb server B5, GUI): render.ts (the tower's standing-by state and the service's notices with their buttons), composer.ts (wakes), chat.ts, scene.ts, and session.ts (the tower unit's service and queue).
	// GUI visual pass (sb server B5) to 1590: towermodel.ts (81: the service's state, last run, queue, notices, and the buttons that answer) and towernotes.ts (26: the notices drawn in the card and the comms), less what render.ts no longer holds; towerturns.ts is the session view's.
	// Desk remainder to 1600 (desk-mode spec S9, S10): desk.ts (the page's desk marker and the Phone rule), quit.ts (Stash and Stashed left out in a desk window), picker.ts (Choose…), main.ts.
	// GUI fix pass (sb server B6) to 1632: towerallies.ts (21: the ally runs' chips), towerturns.ts (97: the verified header and a run's events by their kind), the notice's pointer to the towers (linkbar.ts), and the chips and the notices in render.ts's card and the workspace view.
	// Tower memory (T3) to 1749: towermemory.ts (the memory panel, 78), the panel's model in towermodel.ts (the entries' groups, words, and refusals), the waits-for-you notice's Answer link in towernotes.ts, and the three calls that pass the tower's key or draw the panel.
	// T3 review fixes to 1756: the notices a run's change leaves (Undo and Dismiss on the card and in the panel: towermodel.ts, towernotes.ts, towermemory.ts).
	// Tower memory, pi first (D23): the notices' Undo and Dismiss give way to Confirm and Reject on a run's proposals (towermodel.ts, towernotes.ts, towermemory.ts), the panel's pending section, and the chip's count.
	// Boss conversation (T4) to 1819: towerconv.ts (the comms' box, dividers, chips, Leave and New), the conversation fields in towermodel.ts, and the composer's /quit and /new.
	// T4 visual fix to 1820: the in-event-run row (towerconv.ts) and the composer line.
	// Ended bar (sb server B6) to 1823: gui/composer.ts (barOf and the bar in draw) and render.ts (liveNote: no activity line under a session that is not live), which gui/session.ts calls.
	// Ended dossier (sb server B6) to 1825: render.ts liveMark and the dossier's two calls of it and closed.
	// Phone terminal keyboard (sb server B6) to 1826.
	// Start notices with Retry (sb server B6, RV13-F003 and the nested-shell notice) to 1829: gui/towermodel.ts maps the empty-pane and nested-shell start notices to Retry and their translations.
	// Wi-Fi access, the page (L7): lan.ts (163) and qr.ts (16) are new and pair.ts, post.ts, devices.ts grew by the tabs, the poll, and the network label, to 2008.
	// Review RVL7 (F001 to F011) to 2103: lan.ts 232, lanwait.ts 23, and the tabs' keys and panels in pair.ts.
	// Merge of the page with the firewall reads to 2120: lan.ts 249 (the notes' style, the firewall words, the refused events collapsed per peer).
	// Final review RVLF-F004/F006 to 2122: the two notes worded in zh-TW and the unknown certificate file left out.
	// The Geek view, per device (step 2) to 2216: gui/view.ts (84: the choice and its resolving, the mount that sets data-view and theme-color, the settings' three-way control) is new, and calm.ts, main.ts, notify.ts (the switches' words), and i18n.ts grew by 14.
	// The server's default view (Geek step 3) to 2251: view.ts takes the server's default (the meta, `setServer`, `onServer`, the Auto button's label and its own row) and main.ts feeds it from the hello and the `view` event.
	// Phone layout (step 4) to 2370: gui/menu.ts (84: the `⋯` button, its panel's place, focus, and keys) is new, render.ts wraps a base's and a squad's Quit in it (13), main.ts shows the header's `⋯` while Dismiss finished or Stashed exists and names the route on <body> (13), and i18n.ts names one more page message.
	// Settings page (step 5) to 2442: gui/settings.ts (69: the Phone, Teams, and Server sections filled when opened and dropped when closed) is new, router.ts takes the settings route (+14 with NetRoute and netOf), main.ts opens and leaves the page and moves the panels' opening out of the header (+9 net), notify.ts loses its sound popover (-8), and the rest is the narrower route type.
	// GUI acceptance fixes to 2447: ask.ts marks a card that scrolls (the cue, +12), desk.ts exports the settings page's allowed sections (+2), towerconv.ts keeps an open `⋯` menu across a redraw (+5), menu.ts and main.ts give a few back.
	// The connection overlay to 2531: gui/connect.ts (81: the modal overlay over an inert page while the stream has no live state, with its keys and clicks stopped) is new, and main.ts, stream.ts, and i18n.ts name it.
	// The value zen (Zen step Z1) to 2539: view.ts takes the third view (the type, THEME.zen, the choice), main.ts the header's Zen button and its away sync, and i18n.ts names three messages.
	// A sheet over the overlay (fix/tower-close) to 2532: connect.ts lets a click inside a modal dialog through.
	// Zen model (Z2) to 2631 (with the sheet fix): gui/zenwith.ts (the device's last talk and the companion's target) and gui/zenmodel.ts (the pure model of what Zen shows) are new, alerts.ts and session.ts take `since` and the recording Post.
	// Zen review fixes: gui/viewlabel.ts (the Auto label, out of main.ts) is new, and view.ts takes the Zen back button's mount (out of main.ts): both are testable now, 2639 to 2649.
	// Z1 and Z2 together (the merge) to 2639: the two increments over the common 2531.
	// The Zen layer (Z3) to 2965: gui/zenchunk.ts (3, the chunk's entry with its stylesheet) is new, and gui/zen.ts (the item card, the pause, the companion, and the way out; 227) and gui/intel.ts (11, out of layer.ts) are new; main.ts, fixture.ts, notify.ts, drawer.ts, view.ts, ask.ts, and zenmodel.ts take their few lines.
	// The stuck-overlay way out (fix/connect-stuck) to 2652 (with Z1 and its fixes): connect.ts takes the static Reload link away once the page has booted (+3).
	// Z3 review fixes to 3000: gui/zentypes.ts (37, the layer's deps and mounts types, out of zen.ts so it stays under the spec's 220) and gui/tabicon.ts (10, the tab icon's plain SVG and dotted href, testable); the companion's history fetch, the pause's focus and keys, and the unlocked reply take the rest.
	// An answer that needs the terminal opens it (feat/answer-opens-terminal) to 3030: gui/terminalthen.ts (21, new), the demo's button, ask.ts, main.ts (the page's pane tile), and the pane's key in layer.ts and mirror.ts.
	// Zen Z4 to 3280: zenlines.ts (88, with its 14 sourced lines), zenmenu.ts (87), zenfs.ts (55), soundprefs.ts (14), and the hooks in zen.ts, zentypes.ts, i18n.ts, notify.ts, and main.ts.
	// Zen Z4 feedback to 3575: zenripple.ts (the ripples), viewface.ts (the page's face for every view move), zenkeys.ts (Esc's table), zensize.ts (the card's glide), and the hooks in zen.ts, ask.ts, zenmenu.ts, view.ts, main.ts, and fixture.ts.
	// Both increments summed (answer-opens-terminal +30, Z4 feedback +295): 3605.
	// Views-core R1 to 3624 (+19): gui/units.ts (18, new: the one walk over a net's units and the ranking) and one import line each in main.ts and quit.ts, less one line of zenmodel.ts; alerts.ts (-3, counted in the overlay model) and doc.ts keep one-line calls.
	// Views-core R2 to 3639 (+15): gui/faces.ts (13, new: the rules table and rulesOf) and the imports and rule reads in main.ts (+1) and calm.ts (+1); nothing moves out of those files in this step, since each `zenOn()` it reads becomes a rule read of the same length.
	// Views-core R3a to 3710 (+71): gui/pagecore.ts (123 with its comments, new: createPage(io) holds the page's face, route, stream state and watch, and sends each snapshot to the presenter its face names) takes those from main.ts (352 to 309); stream.ts names the state before the first attempt (+2).
	// Views-core R3b to 3755 (+45): pagecore.ts takes the page's actions (open a session, an alert, a pane; leave and come back to Zen; the notification click; the keys', drawer's, and chime's rules; Escape) out of main.ts (309 to 290) and view.ts names the return to Zen once (+3).
	// Zen terminal layer to 3871 (+116): gui/zenterm.ts (92: the layer's host, button, Esc, and the two returns), its CSS (15 in zen.css), and the hooks in zen.ts, zentypes.ts, zenkeys.ts, mirror.ts, pagecore.ts, main.ts, and fixture.ts.
	// Zen terminal fix round to 3890 (+19): zenterm.ts, mirror.ts, and keypad.ts (the budgets above).
	// Views-core R6 to 3897 (+7): gui/prefs.ts (41, new; soundprefs.ts, 14, gone) takes the stores of notify.ts, view.ts, i18n.ts, layer.ts, zenfs.ts, and zenwith.ts, which lose their try/catch blocks.
	// Several questions in Zen (feat/zen-multi-question) to 3681: gui/zenquestions.ts (87, new); zen.ts keeps its 262 lines.
	// Its fix round (one question at a time, folded lines, paging, Tab through the boxes): gui/zenquestions.ts 87 to 124 (askkeys.ts is a shipped file and has a budget of its own, 74 to 79: the `ask-reveal` call and Tab's new rule).
	// Fix round 2 (short columns, Ctrl+wheel, one-line summaries, summary names): gui/zenquestions.ts 124 to 151 (`need`: the first option whole).
	// Fix round 3 (reset after the fit, foot edge 44, a visible focus target): gui/zenquestions.ts 151 to 159.
	// All increments summed (answer-opens-terminal +30, Z4 feedback +295, several questions +87 +37 +27): 3756.
	// Integration of fix/zen-polish and feat/zen-multi-question on views-core R6 to 4021 (measured): R6's 3897 plus gui/zenquestions.ts (159), the confirm bar (confirmwords.ts, keypad.ts 136), and the questions' hooks in zen.ts (274) and askkeys.ts (80), less zensize.ts.
	// Views-core R7 to 4039 (+18): gui/audio.ts (the playback core, new) takes the context, gain, and clip cache out of notify.ts (-12).
	// R7 review fixes (VC7-F003: out(), running(), unlock() that says if it is running, in audio.ts; the music bus in gui/audiobus.ts, which only the Zen chunk will import) to 4054 (+15).
	// Merge of views-core R7 and the terminal card to 4099 (measured): R7's 4054 plus the card's +45.
	// Views-core R4 to 4116 measured (gui/answer.ts, 16, new: answerPost, trustPost, canAnswer, outcomeOf, mountAnswer; layer.ts 262 to 260, composer.ts 327 to 326, session.ts and main.ts flat, zen.ts 277 to 278): +14 over the 4102 before it, not a move that shrinks; the five rules were each written two or three times in the three views, and the module is the price of one home for them.
	// Views-core R5 to 4114 measured: zen.ts 278 to 276 (counted here); sessionfacts.ts (15, new) and session.ts (151 to 150) are shipped files with budgets of their own. All of gui grows by 12 lines (8756 to 8768), the shared module's price.
	// Zen Z4b (companion keys, palette, status strip) to 4380 measured, +159 over the 4221 the branch base measured (the figure above had not followed Z5 and the earlier merges): gui/palette.ts (63, new: the shared component), gui/paletteentries.ts (38, new: Zen's entries), zen.ts 277 to 309 (cycle, the palette's mount and entries, the strip), zentypes.ts 61 to 69 (the core's selectors, the settings route, a music switch), pagecore.ts 191 to 196, units.ts 18 to 31 (companionsOf, activityOf); hotkeys.ts has its own figure (68 to 71: the alt and mod rows, the platform).
	// Z4b review fixes and the merge with Z4d: 4492 measured (zen.ts 333, hotkeys.ts 73, palette.ts 67).
	// Merge of feat/link-unattended with 0.55.0: 4971 measured (Zen's Z-D16 trim, -133, under the S4b/S5/ut-s6 additions).
	// UT6-F003 (the `withdrawn` dialog state): 4972 measured, +1 (one line in dialogState).
	// Zen lines (feat/zen-lines) to 5023 (measured, +51 over the 4972 above): the 24 added sourced lines of zenlines.ts, two lines each (a source comment and the entry), and its `ja` field and element.
	// A wait for the boss is an alert (docs/specs/2026-10-26-sb-backend.md, Tower memory) to 5113 (measured; the budget was 5023; the chip of an ended wait is one line more): gui/waits.ts (the rules: freshness, age, the alerts of a snapshot) and gui/waitpanel.ts (the dialog's and Zen's panel with Dismiss), and the few lines that reach them in alerts.ts, layer.ts, zen.ts, towermodel.ts, and towernotes.ts.
	// Head tower H4 to 5167 (measured, +144): headpage.ts (new), demo-head.ts (new), the head route, node, wires, drawer row, and the session view's head fields.
	// H4 fix round 2 to 5172 (measured, +5 over the 5167): the head's Close in the conversation row (towerconv.ts) and its composer line (composer.ts).
	// Head tower H5 to 5578 (measured, +406 over 5172): zenhead.ts (the strip, its input and its gestures) and headlines.ts (the lines and the fade clock) are new, zen.ts takes the hooks (+21), and demo-head.ts the strip's states and the head's reply.
	// Head tower H6 to 5599 (measured, +21 over 5578): zenhead.ts takes `quietForwards` (a forward row in the history reads as one quiet line) and the strip's `settle` (a bright strip is not at rest), zen.ts one hook on a line it already had, and demo-head.ts the wait's words by language.
	// Merge of the head tower into main (0.58.0): 5699 measured, the head's 5599 plus the wait alert's +100 (waits.ts, waitpanel.ts and their hooks).
	assert.ok(page <= 5699, `the page's TypeScript has ${page} lines`);
	// Unit status and notices (S5) to 4990 (measured, +24 over the 4966 the branch base measured): linkmodel.ts (`unitsFor`, `unitLine`, the notice line), render.ts (the ally base's unit list), linkbar.ts (a notice's Clear).
	// Unattended review fixes (ut-s6) to 4991 (+1): `unitLine` says "no status lately" for a stale device and the report is titled "Last report" (the two messages that were defined and not used).
	// Forwarded dialog card (feat/link-unattended-dialog-gui) to 4966 (measured, +131 over the 4835 the branch base measured): linkdialogs.ts (48, new: the cards, with the question panel) and linkdialogmodel.ts (44, new: states in words, the check of a sender's dialog shape, the answer's body) load with the first forwarded dialog; linkmodel.ts +11 (`dialogState`), linkbar.ts +28 (the lazy load, the card rows).
	// Z-D16 (every visit starts at the circle): zen.ts 340 to 353 (the circle in the ring, Back to the breath, the start read once a visit, the focus kept off the body on a swap), sessionfacts.ts 15 to 10, gui/zenwith.ts (30) gone.
	// Eager trim round 2 to 4858 (measured): gui/zenrows.ts (Zen's keymap rows, registered by the Zen chunk) is new, hotkeys.ts holds the row engine, and zen.ts takes the `key` dispatch (336 to 340).
	// Eager trim to 4835 (measured): gui/zenpage.ts (38, new) and gui/zenunits.ts (new) take what main.ts, pagecore.ts, and units.ts held for Zen; the lines are moved, plus the two files' headers.
	// Z6 merged with Z4b/Z4d to 4804 (measured): Z5's zensound.ts (94), Z6's zenmusic.ts (116) and zenmusicbar.ts (178), and the music hooks in zen.ts (336), zentypes.ts (70), main.ts, and prefs.ts.
	// Terminal card T5 to 4040 (measured 4035): termcard.ts (129), cardmodel.ts (47), keywriter.ts (70), mirrorconn.ts (82), stepslot.ts (63), and zenhost.ts (59) are new, less keypad.ts (136 to 85), mirror.ts (207 to 192), and the idle bookkeeping of zenterm.ts.
	// Terminal card T7 to 4065 (measured): termwords.ts (18) and confirmbar.ts (12) are new, less keypad.ts (87 to 80) and termcard.ts (129 to 123); cardmodel.ts +2 (the echo of the shown command), keywriter.ts +1.
	// Terminal card review fixes to 4066 (measured): termcard.ts 123 to 148, mirror.ts +1, termwords.ts +1, less what the merge with main moved.
});

test("the built page is small, self-contained (no remote URLs, fonts, or imports), and carries no demo fixture", { skip: !existsSync(join(root, "dist/gui/index.html")) && "run npm run gui:build first" }, () => {
	const dir = join(root, "dist/gui");
	const files = [join(dir, "index.html"), ...readdirSync(join(dir, "assets")).filter((name) => !name.endsWith(".woff2")).map((name) => join(dir, "assets", name))];
	// The one font: the Nerd Font symbols a pane's screen may show (about 1.1 MB), served by the page's own server and fetched only for such a glyph.
	const fonts = readdirSync(join(dir, "assets")).filter((name) => name.endsWith(".woff2"));
	assert.ok(fonts.length === 1 && fonts[0]!.startsWith("SymbolsNerdFontMono-") && statSync(join(dir, "assets", fonts[0]!)).size <= 1_200_000, `fonts: ${fonts.join(", ")}`);
	const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
	// Paraglide's runtime names two placeholder origins in its URL helpers and its docs in an error message; the page fetches none of them.
	const named = ["http://www.w3.org/2000/svg", "http://example.com", "http://fallback.com", "https://paraglidejs.com/errors#no-locale-found"];
	const remote = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]).filter((url) => !named.includes(url));
	assert.deepEqual(remote, [], "nothing is fetched from elsewhere");
	assert.ok(!/@import|<link[^>]+href="https?:/.test(text));
	assert.ok(!text.includes("Harbor API") && !text.includes("demo fixture") && !text.includes("harbor-1"), "the demo fixture stays out of the bundle");
	assert.ok(/EventSource/.test(text), "the built page reads the live stream");
	assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML/.test(text), "no page code writes markup");
	// Budgets from the spec: the map's JavaScript, the lazy chunks together (views, chat with markdown, the overlay layer), and the stylesheet, raw and gzipped.
	const assets = readdirSync(join(dir, "assets")), size = (name: string) => readFileSync(join(dir, "assets", name)), gz = (name: string) => gzipSync(size(name)).length;
	const entry = /assets\/(index-[\w-]+\.js)/.exec(readFileSync(join(dir, "index.html"), "utf8"))?.[1];
	assert.ok(entry, "index.html loads one entry script");
	// What loads at start is the entry and the files it imports statically (the bundler may split a shared module out of the entry: post.ts, the runtimes), so the map's budget below is that sum and the lazy chunks are the rest (VC12-F001).
	const eager = new Set<string>(), reach = (name: string): void => {
		if (eager.has(name)) return;
		eager.add(name);
		for (const found of size(name).toString().matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)) reach(found[1]!);
	};
	reach(entry);
	const chunks = assets.filter((name) => name.endsWith(".js") && !eager.has(name)), css = assets.filter((name) => name.endsWith(".css"));
	const total = (list: string[], measure: (name: string) => number) => list.reduce((sum, name) => sum + measure(name), 0);
	// 0.7.0 raised the gzip figure from 6 KB to 6.1 KB: the page's one stream lives in this chunk, so it routes the terminal tiles' hello and frames to the layer.
	// 0.10.0 to 24.7 KB / 9.75 KB for English and Traditional Chinese (Paraglide): its runtime, about 5 KB raw, whose locale getter stays whole because
	// every message calls it, and the header's, map's, log's, and banner's messages, each a function per locale with both languages' strings.
	// 0.11.0 to 24.75 KB / 9.78 KB for the reload of a page whose server now runs another build (a newer pi-straw-boss took it over).
	// 0.15.0 to 25.65 KB / 10 KB for the map's opening buttons (+ New base, a base's and a squad's + Main or + Member) and their click handler.
	// 0.17.0 raised the map chunk to 27.7 KB / 10.7 KB for the close buttons on bases and squads and the confirmation before each close.
	// 0.18.1 to 28.4 KB / 10.9 KB for the page's own confirm dialog, which a browser confirm() gave way to.
	// 0.18.2 to 29 KB / 11.2 KB for the tab icon's badge, the count of units waiting on an answer.
	// 0.20.0 to 29.55 KB / 11.35 KB for leaving a closed base or unit's view, and Escape left to an open modal.
	// 0.21.0 to 32.65 KB / 12.5 KB for reminders and sounds (notify.ts): the header's two switches, system notifications, and the sounds' URLs
	// (the clips themselves stay files), with their messages in both languages.
	// 0.23.0 to 33.85 KB / 13 KB for the sound panel (on, a volume played through Web Audio's gain, and a try), the popover placement it shares
	// with the finished list, and a finished alert that clears itself once its pane closed.
	// 0.25.0 to 34.55 KB / 13.25 KB for a failed or quiet monitor's alert (its own key, the unit it belongs to, and its note), with the
	// monitors bar's messages in both languages.
	// 0.26.0 to 35.05 KB / 13.4 KB for Quit on the map: each unit's, and the base's and squad's as words instead of ×, in both languages.
	// 0.26.1 to 35.4 KB / 13.45 KB for Quit tower on the map, in both languages.
	// 0.27.0 to 35.4 KB / 13.5 KB for the one Quit module: the four named aim functions and the confirmation moved out of the other files cost a few dozen bytes more than the inline code.
	// 0.27.0 to 36.9 KB / 14.05 KB for the map's packets as keyframes along each wire (packets.ts) instead of SVG animateMotion, the page's rest after 30 s without input (calm.ts), and replay (dom.ts).
	// 0.27.0 to 37 KB / 14.15 KB gzipped: the packets' even spacing (interpolated keyframe points).
	// Unreleased to 37.8 KB / 14.4 KB gzipped for the dialogs' keys (hotkeys.ts: the routing, its listeners, and the hint in each tooltip in both languages).
	// Unreleased to 38 KB / 14.5 KB gzipped for Space on a control the mouse left focused (hotkeys.ts: its pointer and focus listeners and the answer-option exception).
	// Unreleased to 38.1 KB for an opening tile that closes and goes to the session it opened (main.ts).
	// Unreleased to 38.2 KB / 14.55 KB gzipped for the note of a unit kept working by a running monitor, in both languages.
	// Unreleased to 38.75 KB / 14.7 KB gzipped for Dismiss on a finished subagent (quit.ts), in both languages.
	// Unreleased to 38.85 KB for `say`: the note of a unit that only waits on a running monitor flagged red wherever it shows.
	// Unreleased to 39.05 KB / 14.75 KB gzipped for a tower's subagents on the map: under its base's header, and counted in the totals, alerts, and log.
	// Unreleased to 39.5 KB / 14.85 KB gzipped for the HUD's Dismiss finished (quit.ts: the finished subagents counted, the button shown and labelled) in both languages.
	// Unreleased to 40 KB / 15 KB gzipped for the commanding mark (its label, HUD figure, and glow hooks) in both languages.
	// Unreleased to 40.5 KB / 15.2 KB gzipped for loading the phone drawer (main.ts) and the glow of the commanding mark's neighbours (labels shared with the drawer).
	// Unreleased (stash and pop on the page): stash.ts 262 to 284 (stashedList, close all naming its base; nameFor, the server's session asked again before its base is stashed, a failed pop never stashed over another), closer.ts 74 to 87 (close/pop), host.ts 110 to 111 (the import of
	// popBase and stashedList). The map chunk to 42.7 KB / 15.8 KB gzipped for stash and pop on the map (quit.ts: a base's Stash, the HUD's Stashed list with Pop, Quit checked first) in both languages.
	// Unreleased (net sidecar) to 42.8 KB / 15.85 KB gzipped for the agent badge on a unit that is not a pi session (the card and the token).
	// Unreleased (comfort) to 43.25 KB / 16 KB gzipped for the bases packed like masonry and the header's height published for what sits under it (render.ts).
	// Unreleased (comfort) to 47.05 KB / 17.25 KB gzipped for what a card says it did lately (its clock, its todo in short, its last steps) and the cards' clock, the timeline (timeline.ts) in place of the net log, and the map's overview (minimap.ts), with their messages in both languages.
	// 0.42.0 (calm header) to 47.2 KB: the settings panel's button (its name in both languages, where it hangs).
	// Unreleased to 47.25 KB / 17.3 KB: the links and the overview drawn on the next frame after the cards' packing, not by an observer of the map.
	// Unreleased to 47.35 KB / 17.31 KB: the comms' Back steps back through the page's own history (router.ts depthOf, data-back).
	// Unreleased to 47.4 KB / 17.33 KB: quit.ts's dismiss shared with the drawer's swipe.
	// Unreleased to 47.45 KB / 17.36 KB: Notifier.chime, the unit-ready sound of the deploy panel (the panel and its messages are in the opening tile's lazy chunk).
	// Unreleased to 53.15 KB / 19.05 KB (Straw Link 53 KB, the session view's Quit the rest): Straw Link's part of the map (linkbar.ts: the header's notices and the forwarded confirm; linkmodel.ts: their words, the invite's countdown, an ally's mark; render.ts: the teammates' bases) and its messages in both languages. The team settings tile itself is a lazy chunk.
	// Unreleased to 47.65 KB / 17.45 KB: the session view's Quit (quit.ts aimSession, the map's own Quit aimed at the unit in view); chat.ts 275 to 277 and session.ts 121 to 122 lines for the role label on a message and the Quit.
	// Unreleased (project trust) to 53.65 KB / 19.3 KB gzipped: a trust question as an alert (alerts.ts), its reminder and its place in the HUD and the tab badge (notify.ts, main.ts), with the messages the map uses in both languages.
	// Unreleased (GUI in the sb server) to 54.35 KB / 19.5 KB gzipped: the header's Server button (this computer's page only) and its two messages in both languages; the panel itself is a lazy chunk (gui/server.ts).
	// Unreleased (settings check) to 53.85 KB: quit.ts's Pop reads the refusal facts of a folder pi must not start in (the words are in the lazy deploy chunk, gui/refusal.ts).
	// Unreleased (R-F001) to 54.95 KB / 19.7 KB gzipped: the `replaced` state of the stream (one look at the page's address after an error) and its banner in both languages.
	// Unreleased (IRQ-F001) to 55.0 KB / 19.75 KB gzipped: the longer banner words in both languages (and the `replaced` dot's colour in the stylesheet).
	// Unreleased (sb server B5, GUI) to 56.4 KB / 20.2 KB gzipped: the tower unit of the service (standing by, the notices with Retry, Deliver again, and Drop in render.ts, the composer's wake line, the served-inbox notice) and its messages in both languages.
	// After the merge with 0.46.0 (its `replaced` state and banner, 55.0 KB / 19.75 KB alone) to 56.95 KB / 20.4 KB.
	// GUI visual pass (sb server B5) to 62.15 KB / 22.15 KB gzipped: the tower service's words in both languages (its states, last run, queue count, notices, refusals; five of them plural) and the notices' buttons that say "Working…" and show a refusal.
	// Desk remainder (S9) to 62.35 KB / 22.2 KB gzipped: the desk marker read once at load (desk.ts) and the Phone, Stash, and Stashed buttons left out in a desk window.
	// GUI fix pass (sb server B6) to 64.75 KB / 22.95 KB gzipped: a run's events read by the kind the server sent them with, the teammates' labels and the folded header (chat.ts, towerturns.ts), the ally runs' chips and words (towerallies.ts, towermodel.ts), the workspace view's queue chip and notices, and their messages in both languages.
	// Tower memory (T3) to 67.35 KB / 23.8 KB gzipped: the panel's, the waits-for-you notice's, and the memory route's messages in both languages (the map chunk carries every message).
	// T3 review fixes to 68.25 KB / 24.1 KB gzipped: the notices a run's change leaves, with their words and the Undo and Dismiss buttons (four more messages in both languages).
	// Tower memory, pi first (D23) to 68.9 KB / 24.2 KB gzipped: the proposals' words in both languages (Confirm, Reject, the card's sentences, the panel's heading and citation) in place of the notices'.
	// Merge of T3 with the B6 GUI fixes: 68.9 KB to 68,903 bytes (the read-only channel word and the origin words beside the memory words).
	// Boss conversation (T4) to 71,362 bytes / 24.91 KB gzipped: the state words, the box above the composer, Leave and New, the dividers, and the event-run chips in both languages.
	// T4 review fix 1 to 71,500 bytes / 25.0 KB gzipped: the conversation placeholder and the event-run words in both languages; towers.ts to 855 (the brief names an event run the boss spoke in).
	// Ended bar (sb server B6) to 72,700 bytes / 25.5 KB gzipped: the bar's message in both languages (the map chunk carries every message), barOf, and liveNote.
	// Start notices with Retry (sb server B6, RV13-F003, the nested-shell notice, RV14-F004) to 74,000 bytes / 25.8 KB gzipped: the empty-pane, could-not-check, types-nothing and not-at-its-own-shell notices in both languages.
	// Wi-Fi access, the page (L7) to 74,100 bytes: the Same Wi-Fi tab's, the device network labels', and the tabs' messages in both languages (the map chunk carries every message).
	// Review RVL7 to 74,400 bytes / 25.85 KB gzipped: the page's words for the server's notes and events, the ages, the download links, and the waiting notice in both languages.
	// The Geek view, per device (step 2) to 76,500 bytes / 26.6 KB gzipped: gui/view.ts (the choice, its resolving, the three-way control) and its words in both languages (the map chunk carries every message), and the switches' state words (notify.ts).
	// The server's default view (Geek step 3) to 77,400 bytes / 26.9 KB gzipped: view.ts's server default (the meta, `setServer`, the Auto button's label) and main.ts's hello and `view` event handling, with the Follow server message in both languages.
	// Phone layout (step 4) to 80,200 bytes / 27.9 KB gzipped: gui/menu.ts (the `⋯` button, its panel's placement, focus, and keys; the fold of the base's and squad's Quit into it), the HUD's `⋯` for Dismiss finished and Stashed (main.ts), and four more messages in both languages (the map chunk carries every message).
	// The connection overlay to 81,500 bytes / 28.4 KB gzipped: connect.ts (the modal overlay, its stopped clicks and keys) and its three messages in both languages (the map chunk carries every message).
	// The value zen (Zen step Z1) to 82,200 bytes / 28.7 KB gzipped: the fourth button, the Zen header button, three messages in both languages (the map chunk carries every message).
	// A sheet opened over the overlay stays usable (fix/tower-close) to 81,700 bytes / 28.5 KB gzipped: connect.ts lets a click inside a modal dialog through.
	// Zen model (Z2) to 81,900 bytes / 28.55 KB gzipped (with the sheet fix): the composer's Post recording the device's last talk (zenwith.ts, session.ts 150 to 151 lines).
	// Z1 and Z2 together (the merge) to 82,600 bytes / 28.85 KB gzipped: the two increments over the common 81,500 / 28.4.
	// The Zen layer (Z3) to 83,800 bytes / 29,250 gzipped (this test's gzip): main.ts loads the Zen chunk and its deps, tells it the snapshots, the stream's watch, and the way out, and `face` leaves and enters (about 1.55 KB raw / 0.56 KB gzipped over Z1 and Z2); the spec's 1.6 KB / 0.7 KB entry budget for the whole view is passed by about 0.6 KB raw.
	// Z3 review fixes to 83,950 bytes / 29,250 gzipped: the icon helper (gui/tabicon.ts) and the history fetch add about 0.1 KB raw. The overshoot of the spec's 1.6 KB / 0.7 KB entry budget (now about 0.7 KB raw, gzip within) is the boss's to accept: it is the price of the Zen hooks in main.ts that the spec could not see before Z3, recorded here and in the spec's status line.
	// An answer that needs the terminal opens it (feat/answer-opens-terminal) to 84,450 bytes / 29,450 gzipped: main.ts registers the page's pane tile (`onPane`, terminalthen.ts), and the one message (the map chunk carries every message).
	// Both increments summed (answer-opens-terminal +500 / +200 gzipped, Z4 +650 / +250): 85,100 bytes / 29,700 gzipped.
	// Zen feedback round to 85,600 bytes / 29,800 gzipped: viewface.ts (what a view move does to the page's face: one table, the page's coordinator calls it), the pick that tells its listeners every time (view.ts), the capture-phase Escape, and two messages in both languages.
	// All three increments summed (answer-opens-terminal +500 / +200, Z4 +650 / +250, Z4 feedback +1,000 / +350): 86,100 bytes / 30,050 gzipped.
	// Views-core, measured as the entry plus the files it imports statically (eager bytes; this test's gzip). 0.52.0: 88,615 / 31,291 (entry 85,966 with post.ts inside it). R1 (units.ts replaces the unit walks of alerts.ts, quit.ts, and main.ts; post.ts, 806 bytes, now sits in a file the entry imports): 88,609 / 31,545, so R1 is -6 raw / +254 gzipped (the split costs gzip). R2 (faces.ts: 24 table cells whose key names cannot be mangled, and the reads of it): 89,003 / 31,725, +394 raw / +180 gzipped over R1, +388 / +434 over 0.52.0.
	// Views-core R3a (gui/pagecore.ts: createPage(io) takes the page's face, route, stream state and watch out of main.ts, which hands it 16 parts): 89,759 / 32,262, +756 raw / +537 gzipped over R2 (entry alone 86,304 / 30,529). The seam costs what the moved code does not give back: the parts handed in, the `core.` reads in main.ts, and draw and navigate as functions of their own. The cap for R3 as a whole is 1.0 KB raw over R2.
	// Views-core R3b (the actions, 7 more parts handed in): 89,908 / 32,209, +905 raw / +484 gzipped over R2 (entry alone 86,453 / 30,476), inside the 1.0 KB raw cap for R3 as a whole that sb backlog set after R3a measured +756: a seam of 23 parts, not code that grew.
	// Zen terminal layer (the layer itself is in the Zen chunk; the entry takes only the page's two calls and the shared `embed`): 90,058 / 32,256, +150 raw / +47 gzipped over R3b, inside the 0.3 KB cap that sb backlog set.
	// Views-core R6 (gui/prefs.ts: one typed store for the device's preferences, replacing soundprefs.ts and the stores in notify.ts, view.ts, i18n.ts, layer.ts, zenfs.ts, and zenwith.ts; Sound and Volume now follow another tab): 90,346 / 32,404, +288 raw / +151 gzipped over the Zen terminal layer (90,058 / 32,253), inside the 0.3 KB raw cap.
	// R6 review follow-up (VC6-F002: the open Zen menu redraws when another tab changes Sound or Volume, `Notifier.sound.onChange`): 90,415 / 32,421, +69 raw / +17 gzipped over R6.
	// Views-core R7 (gui/audio.ts: the one playback core, a context and a gain shared by every view; notify.ts plays through it): 90,599 / 32,497, +184 raw / +77 gzipped over 53438f4 (90,415 / 32,420), inside the 0.3 KB raw cap.
	// R7 review fixes (VC7-F003: audio.ts exposes the context and master gain, `running()`, and an `unlock()` that answers; the music bus is audiobus.ts, outside the entry): 90,639 / 32,518, +40 raw / +21 gzipped over R7, +224 / +98 over 53438f4 (90,415 / 32,420), inside the 0.3 KB raw cap.
	// Merge of views-core R7 and the terminal card: 90,678 / 32,551, +39 raw / +33 gzipped over R7's fixes, +263 / +131 over 53438f4, inside the 0.3 KB raw cap.
	// One-tap prompt run (feat/onetap-prompt-run): 90,798 / 32,610, +120 raw / +59 gzipped over the merge (the answer id and `then.run` carried from ask.ts through openThen into the step); the card, the writer, and the new words are lazy.
	const eagerBytes = total([...eager], (n) => size(n).length), eagerGz = total([...eager], gz);
	// Views-core R4 (answer.ts stays out of the entry; post.ts's import moves with the callers): 90,697 / 32,552, +19 raw / +1 gzipped over c5e302f (90,678 / 32,551), inside the 0.1 KB raw cap.
	// Merge of views-core R4 and the one-tap run: 90,817 / 32,612 (measured), the run id carried through pagecore's step.
	// Eager trim (fix/eager-trim): by 314cad1 the entry had grown to 93,330 / 33,543 (a45f2cc: 90,947 / 32,723 with the sourcemap comment, 90,817 / 32,612 without). Zen-only code moved behind the Zen load: the sound, the music block and the companion readers into gui/zenpage.ts (built by the zen chunk), companionsOf and activityOf into gui/zenunits.ts; pagecore hands out `newest()` instead. Measured 92,097 / 33,144: +1,280 / +532 over the last cap, all of it the keymap rows (hotkeys.ts +703, Z4b/R8) and the core's routing (pagecore.ts +253, main.ts +198, prefs.ts +88 for the two music keys).
	// Eager trim round 2: 91,519 / 32,914 (measured), -578 / -230 from 92,097 / 33,144. Zen's keymap rows and their modifier and terminal gates (gui/zenrows.ts) are registered by the Zen chunk, and the page hands every Zen key to one `key` call on the layer (pagecore.ts). Still +702 / +302 over the 90,817 / 32,612 before Z4b: hotkeys.ts's row engine, pagecore.ts's and main.ts's routing, and prefs.ts's two music keys (88) stay eager, and cannot move without a lazy key in the typed prefs store or a second keymap path in the core. Cap = measured + 15.
	// Forwarded dialog cards (feat/link-unattended-dialog-gui): 92,381 / 33,199 (measured), +545 raw / +204 gzipped over the 91,836 / 32,995 the branch base (af392fb, S1 to S4a merged) measures, which already stood 302 / 66 over the cap above: the notice's `dialogState`, the lazy load, and the card's rows in linkbar.ts, and the eight state words used by the lazy cards stay out. The cards and the question panel (ask.ts) are lazy chunks. Cap = measured + 15.
	// Unit status and notices (S5): 93,683 / 33,591 (measured), +1,302 raw / +392 gzipped over the 92,381 / 33,199 the branch base measures: the notice's line and Clear, the ally base's unit list (`unitsFor`, `unitLine`), and five messages in both languages.
	// Merge with 0.55.0 (Zen Z-D12 to Z-D16 on main): 93,905 / 33,636 (measured), +222 / +45 over the S5 figure. Cap = measured + 15.
	// UT6-F003 (`withdrawn` state and its two messages): 93,933 / 33,650 (measured), +28 raw / +14 gzipped over the merge figure. Cap = measured + 15.
	// A wait for the boss is an alert (gui/waits.ts): 94,897 / 33,944 (measured), +964 raw / +294 gzipped over the 93,933 / 33,650 above: the alerts of a snapshot's fresh waits (`waitAlerts`, which `alertsOf` calls on every snapshot), the line of a wait with its age and "may be out of date" (`waitLine`, the tower card's row), and four messages in both languages. The dialog's and Zen's panel (gui/waitpanel.ts) is in the lazy chunks. Cap = measured + 15.
	// The tab icon counts the waits the tower recorded on the boss (pagecore.ts): 95,004 / 33,983, cap 95,010 / 33,990.
	// Head tower H4 (the header button, the head node, the page, the drawer row, the chapter divider, their words): 97,934 / 34,835 (measured). Cap = measured + 15.
	// Head tower H4 review fixes: 98,083 / 34,866 measured (the chapter reasons, the news dots, the head-named speaker). Cap = measured + 17 / + 14.
	// Merge of the head tower into main (0.58.0): 99,171 / 35,198 measured, the head's 98,083 / 34,866 plus the wait alert's figures. Cap = measured + 19 / + 17.
	// Head polish (after 0.58.0: the head node's title and the key's message): 99,233 / 35,216 measured, +62 / +18 over the merge figure. Cap = measured + 15.
	assert.ok(eagerBytes <= 99_248 && eagerGz <= 35_231, `the map chunk and the files it loads at start are ${eagerBytes} bytes (${eagerGz} gzipped)`);
	// The lazy chunks' gzip figure was 12 KB; 0.5.0 raised it to 14 KB for the composer (about 2.2 KB gzipped) and the phone pairing tile with its POST helper (about 1.1 KB).
	// The question panel (0.5.0, read-only, about 0.7 KB gzipped) and its place in the dialogs and the session view raised the gzip figure to 15.5 KB;
	// 0.5.1 to 36.5 KB / 16.2 KB for the composer's note and the dialogs of units that left the net (about 0.7 KB gzipped together).
	// 0.6.0 to 40 KB / 17.5 KB for the answer panel (gui/ask.ts: a select with notes and Copy command, questionnaires with own words and notes, outcomes and Check again; about 1.2 KB gzipped),
	// and to 40.5 KB raw for a panel that belongs to its dialog across the net's updates (about 0.5 KB, 0.1 KB gzipped).
	// 0.6.1 to 40.9 KB / 17.8 KB for the panel's busy, linger, and focus fixes and the tool card's "show all arguments" (about 0.35 KB, 0.26 KB gzipped).
	// 0.7.0 to 46.5 KB / 20.3 KB for the terminal tile (gui/mirror.ts: the SGR renderer, frames, fit width, parking, about 2.3 KB gzipped with its place in the layer and the dossier).
	// And to 48.5 KB / 21 KB for the key pad (gui/keypad.ts: 23 keys in rows, the digits folded, the server's confirm inline; about 0.6 KB gzipped).
	// 0.8.0 to 52 KB / 22.5 KB for the document tiles (gui/doc.ts: the sandboxed frame, text and markdown, revisions, arrivals, the dossier list; about
	// 3.8 KB, 1.45 KB gzipped with Open beside and the dossier). The Phase 3 plan proposed 50 KB / 21.5 KB for the terminal tile, key pad, and document
	// tile together, estimating the document tile at about 1 KB gzipped: this is 2 KB raw and 1 KB gzipped over that proposal.
	// 0.10.0 to 67.1 KB / 28.05 KB for the messages of the focus views, comms, dialogs, and tiles in both languages (Paraglide, as in the map chunk).
	// 0.12.0 to 67.85 KB / 28.35 KB for the pairing tile asking to turn remote access on, in both languages.
	// 0.13.0 to 71.6 KB / 30.2 KB: the opening tile (a folder picker and two forms, its own chunk loaded on click) and the base view's two buttons, in both languages.
	// 0.14.0 to 72.6 KB / 30.6 KB for the composer's `/` menu (gui/slash.ts) and the follow-up button's hint, in both languages.
	// 0.15.0 to 74.3 KB / 31.1 KB for the new base, member, and squad member tiles, and the composer's file paste, drop, and picker, in both languages.
	// 0.17.0 to 74.9 KB / 31.3 KB for the close button in a unit's view and the close confirmations in both languages.
	// 0.17.2 to 75.1 KB / 31.3 KB for the launcher levels in the location bar; 0.17.3 to 75.3 KB / 31.35 KB for the motion of new messages.
	// 0.18.1 to 76.4 KB / 31.7 KB for the session view's chat and terminal modes.
	// 0.18.2 to 76.9 KB / 31.8 KB for the comms header's close button.
	// 0.19.0 to 77.7 KB / 32.1 KB for the session's todo list above the composer and the finished alert that needs no Later.
	// 0.20.0 to 80.45 KB / 33.3 KB for thumbnails and their lightbox (its own chunk), the queue under the chat, and the queued labels.
	// 0.23.0 to 81.85 KB / 33.8 KB for the finished list in the overlay layer: the HUD's Finished button, its rows, and Clear all.
	// 0.24.0 to 86.05 KB / 35.4 KB for a dialog's Enlarge, and a desktop's keyboard straight into a focused terminal (keypad.ts and mirror.ts in the
	// overlay layer: the key and chord map, the hidden text box for characters, input methods, and pastes, the paced write queue, and the note and glow).
	// 0.25.0 to 88 KB / 35.9 KB for the monitors bar in the comms view, and the terminal taking the keyboard as the view switches to it.
	// 0.25.1 to 88.1 KB for a phone's comms scrolled into view as the session opens.
	// 0.26.1 to 88.6 KB / 36.05 KB for a phone's Info and its full-screen dossier with a tower's squads, and a log held while a finger drags it.
	// 0.27.0 to 89.55 KB / 36.425 KB: views.ts split into eight modules costs about 0.9 KB raw (0.4 KB gzipped) in the same chunk, for the parameters that carry the
	// Scene and the `scene.` property reads that do not minify.
	// 0.27.0 to 89.6 KB / 36.5 KB (+0.08 KB / +0.08 KB gzipped) for markdown.ts handing a nested body down as lines with the indents measured once, which is what takes the 3,000-line staircase from 210 ms to 15 ms.
	// Unreleased to 89.7 KB: layer.ts's hotkey entry for Space and F, and the tooltips' key hints in both languages.
	// Unreleased to 92.1 KB / 37.5 KB for the answer form's keyboard (gui/askkeys.ts, about 2.3 KB raw and 1.0 KB gzipped) and the focus on a dialog's first option.
	// 0.28.0, with the answer keys, to 94.6 KB / 38.4 KB: the secret panel (+2.3 KB / +0.8 KB gzipped) (gui/ask.ts) and its nine messages in both languages.
	// Unreleased to 101.7 KB / 41.9 KB gzipped for the notices list's plural and the Notices button's tint, after 101.5 KB / 41.8 KB for the phone drawer (gui/drawer.ts and swipe.ts, about 4 KB raw, with their messages in both languages), after 96 KB / 38.8 KB for the paired devices under the pairing code (gui/devices.ts, with its messages in both languages) and the answer panel without its read-only confirm.
	// Unreleased (net sidecar) to 102 KB / 41.95 KB gzipped for the composer's notice about an agent that is not pi (both languages).
	// Unreleased (comfort) to 41.98 KB gzipped: the lazy chunks import the map chunk by its hashed name, and a new hash gzips a few bytes differently.
	// Unreleased to 102.05 KB / 42 KB gzipped: layer.ts watches a gauge of the work's width (the gauge made and observed), and the column template's agent slot.
	// Unreleased to 102.1 KB: the comms' Back marked data-back, to step back through the page's history.
	// Unreleased to 102.8 KB / 42.25 KB gzipped: the drawer's swipe to dismiss a finished subagent's card (gui/drawer.ts).
	// Unreleased to 103.2 KB / 42.55 KB gzipped: a tower's comms head carries "+ Main" (gui/session.ts, scene.ts).
	// Unreleased to 103.5 KB / 42.7 KB gzipped: the drawer's map link and Dismiss finished button (gui/drawer.ts, with its message in both languages).
	// Unreleased to 113 KB / 46.3 KB gzipped: the folder picker (gui/picker.ts, folders.ts), nine more messages in both languages; and
	// Unreleased to 107.7 KB / 44.4 KB gzipped: the deploy panel (gui/deploy.ts: steps, bar, clock, finish, failure), its demo server, and its twelve messages in both languages.
	// Unreleased to 113.6 KB / 46.6 KB gzipped: the deploy panel measures silence, and closes with its tile; the picker lands on a column edge.
	// Unreleased (project trust) to 118.9 KB / 49.3 KB gzipped: the trust panel (gui/trust.ts, its own chunk loaded with the first dialog or deploy), the dialog's and the deploy step's use of it, and sixteen messages in both languages.
	// Unreleased to 135.4 KB / 55.15 KB gzipped: the team settings tile (gui/link.ts, its own lazy chunk: forms, roster, invite with its QR, the safety words, the camera) and its messages in both languages.
	// Unreleased to 135.95 KB / 55.3 KB gzipped: the leave confirm for an only admin and the page's label and share prefill (gui/link.ts), the session view's Quit.
	// Unreleased to 136.1 KB / 55.4 KB gzipped: a choice only this computer may give (`hereOnly`) is shown disabled on a paired device (gui/ask.ts).
	// Unreleased (queue Edit, on top of the drawer's) to 141.5 KB / 57.25 KB gzipped: the queue's Edit (its bar and wiring, the composer's take-back with its id and the reply kept for a composer that is gone, seven messages in both languages).
	// Unreleased to 137.1 KB / 55.7 KB gzipped: the drawer's tower row (icon and +), Quit on an idle main, and the map link in its foot (gui/drawer.ts).
	// With project trust: the panel chunk and its messages add 5.3 KB / 2.7 KB gzipped to the figures above (142.45 KB / 58.45 KB gzipped in all).
	// Unreleased (project trust review fixes): the chat chunks measure 142953 bytes (58690 gzipped) after a fresh build, up from 142450: the two outcome messages (gone, changed), the scroll of the trust step into view, and the changed notice kept beside the new question.
	// Merged with the queue's Edit: 147.6 KB / 60.35 KB gzipped in all.
	// Unreleased (settings check): 149.1 KB / 61.25 KB gzipped: the refusal of a folder pi must not start in, worded from the server's facts (gui/refusal.ts, three messages in both languages).
	// Unreleased (hereOnly, merged with the queue's Edit and project trust; the settings check adds the refusal wording, gui/refusal.ts) to 149.15 KB / 61.3 KB gzipped: the disabled hereOnly choice on a paired device (gui/ask.ts) on top of the queue's Edit.
	// Unreleased (settings check, probe): 149.55 KB / 61.4 KB gzipped for the fourth refusal message, `unchecked` (could not be checked in time), in both languages.
	// Unreleased (the Edit's refusals in the page's language) to 152.4 KB / 62.4 KB gzipped: eleven messages in both languages (gui/composer.ts takeWhy) so a take-back's refusal is not English under zh-TW.
	// Unreleased (GUI in the sb server) to 155.6 KB / 63.85 KB gzipped: the server panel (gui/server.ts, a lazy chunk of about 3.2 KB) and its messages in both languages.
	// Unreleased (sb server B5, GUI) to 155.8 KB / 63.9 KB gzipped: the composer's wake placeholder and the tower notice messages that the chat chunk carries.
	// GUI visual pass (sb server B5) to 157.4 KB / 64.25 KB gzipped: towerturns.ts (a run's turns the server wrote, the Terminal tab's sentence, a refused send's words) and the session view's tower code, with their messages in both languages.
	// Review RV-F001 to 158.2 KB / 64.6 KB gzipped: the boss turn of a service tower without the server's marker line (bossTurn) and its crash note in both languages.
	// Desk remainder (S10) to 158.5 KB / 64.7 KB gzipped: the folder picker's Choose… button for the desk shell's native dialog, with its two messages in both languages.
	// GUI fix pass (sb server B6) to 162.8 KB / 66.3 KB gzipped: a run's events read by their kind, the teammates' labels and the folded header, the ally runs' chips and comms, the standing-by sentence, and their messages in both languages.
	// GUI fix pass 2 (sb server B6) to 163.4 KB / 66.5 KB gzipped: the read-only channel word, the local and teammate origin of a message, and the sender line read from the server's marker.
	// Tower memory (T3): the memory panel, its model, and the proposals' words add 4.05 KB / 1.3 KB gzipped to the chat chunks.
	// Boss conversation (T4) to 171,147 bytes / 69.0 KB gzipped: the comms' box, dividers, event-run chips, Leave and New, and their messages in both languages (towerconv.ts).
	// T4 review fix 1 to 171,850 bytes / 69.25 KB gzipped: the event-run words and the conversation placeholder.
	// T4 recheck round 2 to 172,059 bytes / 69.26 KB gzipped: the event run's own read-only reason, in both languages.
	// T4 visual fix to 172,700 bytes / 69.5 KB gzipped: the in-event-run row and the composer line, in both languages.
	// Remote app entry (D25) to 163.1 KB / 66.4 KB gzipped: the pairing tile shows the code to type in an installed app (gui/pair.ts, one message in both languages).
	// Ended bar (sb server B6) to 173,100 bytes / 69.6 KB gzipped: the bar line and its message in both languages.
	// Kept GUI address (D27) to 173,300 bytes / 69.7 KB gzipped: the Restart panel's confirm and note say the address is kept, in both languages.
	// Wi-Fi access, the page (L7) to 188,400 bytes / 75.1 KB gzipped: the pairing tile's chunk with the Same Wi-Fi tab (gui/lan.ts, gui/qr.ts) and its messages in both languages.
	// Review RVL7 to 197,700 bytes / 78.4 KB gzipped: the Same Wi-Fi tab's codes worded in both languages (fifteen messages, each a function in the chunk), the waiting notice, and the download links.
	// Merge of the page with the firewall reads to 202,800 bytes / 80.1 KB gzipped: the firewall notes worded in both languages (ten messages), the notes' error or neutral style, and the refused events collapsed per peer (lan.ts to 250).
	// Final review RVLF-F006 to 203,500 bytes / 80.3 KB gzipped: the two notes that showed in English on the zh-TW page (stays_off_error, fw_other) are worded in both languages (lan.ts to 253).
	// Not-verified wording (0.50.0) to 204,000 bytes / 80.4 KB gzipped: `lan_unverified` and the longer `lan_risk_short`, in both languages (lanface.ts to 367).
	// Phone layout (step 4) to 206,000 bytes / 81.0 KB gzipped: the tower conversation's one-line bar with its `⋯` menu (towerconv.ts), the queue's fold row (bars.ts), the head's menu markup and the workspace's tower row in the drawer, and four messages in both languages.
	// Settings page (step 5) to 208,000 bytes / 82 KB gzipped: gui/settings.ts (the sections that fill when opened, 1.4 KB, its own chunk) and the messages of the page in both languages (the map chunk carries every message; the lazy chunks import it by its hashed name).
	// Cancel (fix/ask-cancel) to 208,700 bytes / 82.4 KB gzipped: the question card's Cancel button (gui/ask.ts), its cancel body and outcome, and its two messages in both languages.
	// Zen model (Z2) to 209,000 bytes / 82.45 KB gzipped: session.ts records the device's last talk through zenwith.ts.
	// The Zen layer (Z3) to 218,300 bytes / 88.1 KB gzipped: gui/zen.ts (8.6 KB raw, 3.8 KB gzipped, inside the spec's 14 KB / 5.5 KB for the chunk), its stylesheet, intel.ts, and the `zen_*` words in both languages (they sit in the Zen chunk, not the map's).
	// Z3 review fixes to 218,700 bytes / 88.2 KB gzipped: the companion's history fetch, the pause's focus and keys, and the unlocked reply (about 0.35 KB raw).
	// An answer that needs the terminal opens it (feat/answer-opens-terminal) to 219,400 bytes / 88.5 KB gzipped: the question card's `opens` hook (ask.ts), the one shared call (terminalthen.ts), and its one message in both languages.
	// Zen Z4 to 225,200 bytes / 91.1 KB gzipped: the Zen chunk grows by the corner menu, full screen and its hint, the idle line with its 14 sourced lines in both languages, and the dissolving card (JavaScript about 15.6 KB raw / 6.9 KB gzipped, over the spec's 14 KB / 5.5 KB for the chunk; the stylesheet is counted below).
	// Zen feedback round to 229,000 bytes / 92.7 KB gzipped: the Zen chunk grows by the ripples (zenripple.ts), Esc's table and the quiet line, the card's glide, and the draft's hold (about 3.7 KB raw / 1.5 KB gzipped).
	// All increments summed (answer-opens-terminal +700 / +300, Z4 +6,500 / +2,900, Z4 feedback +3,800 / +1,600): 229,700 bytes / 93,000 gzipped.
	// Views-core: the figure counts the lazy chunks only now (VC12-F001); post.ts and the runtimes are eager. At 0.52.0 they were 226,642 / 91,444, R1 added units.ts's share to the lazy chunks that import it: 226,692 / 91,472, and the cap is 226,750 / 91,550.
	// Zen terminal layer: the layer (zenterm.ts, in the Zen chunk) and the embed options in the overlay chunk: 228,825 / 92,327, +2,133 raw / +855 gzipped over R1's 226,692 / 91,472; the eager bytes grew by 150 only.
	// Zen terminal fix round: 229,790 / 92,677 (+965 raw / +350 gzipped: the Enter rule, the tower's sentence, Shift+Esc, the pad's state on the sink, and the two messages' words), cap 229,900 / 92,800.
	// Terminal card T1 (gui/mirrorconn.ts: the connection core out of mirror.ts, now shared by the tile, `embed`, and `watch`, with a rows model and a watcher set): 231,072 / 93,093, +1,357 raw / +438 gzipped over the fix round's 229,715 / 92,655 (main at bf95cbd), cap 231,100 / 93,100. The eager bytes did not grow: 90,415 / 32,420.
	// Several questions merged over the terminal layer: 234,078 / 94,306, cap 234,100 / 94,400.
	// Zen polish (the pad confirm's words by token: six messages in both languages and gui/confirmwords.ts, the card's fade, the click-only menu): 235,693 / 94,944, cap 235,700 / 95,000.
	// Several questions in Zen (feat/zen-multi-question) to 231,400 bytes / 93,600 gzipped: gui/zenquestions.ts (the Zen chunk, from 229,291 / 92,784 to 231,357 / 93,541: +2.1 KB raw, +0.8 KB gzipped).
	// Its fix round (folded lines with their summaries, paging by wheel and swipe, the deeper foot edge) to 232,691 bytes / 94,096 gzipped (+1,300 / +550 over the first round).
	// Fix round 2 (dropping far lines on a short column, Ctrl+wheel, summary names in both languages) about +900 / +450.
	// Integration of fix/zen-polish and feat/zen-multi-question to 236,000 bytes / 95,200 gzipped (measured 235,805 / 94,995): both branches' Zen chunk growth summed, less zensize.ts.
	// Merge of the terminal card's T1 (mirrorconn.ts, +1,357 / +438 over main's 235,805 / 94,995) with main d922096: 237,236 / 95,489, cap 237,300 / 95,500.
	// Terminal card T2 (gui/keywriter.ts: the pad's queue, gap, confirm token, and refusal drop, shared with the card; `taken` through mirror.ts and mirrorconn.ts): 237,684 / 95,683, +448 raw / +194 gzipped, cap 237,750 / 95,750.
	// Terminal card T5 (the card, its model, the dock's slot, Zen's host, and the card's 13 messages join the lazy chunks): 246,268 / 99,528, +8,584 raw / +3,845 gzipped over T2's 237,684 / 95,683, +10,463 / +4,533 over main d922096's 235,805 / 94,995, cap 246,300 / 99,600. The spec aimed at +3.5 KB / +1.4 KB; T7 trims toward it and records the final figure. The eager bytes: 90,455 / 32,449, +40 / +29 over 90,415 / 32,420 (pagecore.openStep, main.ts's registration), cap 90,500 / 32,480.
	// Terminal card T7 (the refusals of a terminal's keys and mirror, 13 codes and 5 ended reasons, in both languages: gui/termwords.ts and 18 messages; the echo of the shown command dropped from the rows; gui/confirmbar.ts shared by the pad and the card): 249,813 / 101,040, +14,008 raw / +6,045 gzipped over main d922096's 235,805 / 94,995, cap 249,850 / 101,100. Of the +14.0 KB, the messages are about 6.5 KB (the card's 13 and the refusals' 18, an English and a Chinese text each) and the code about 7.5 KB (termcard.ts 4.6 KB, mirrorconn.ts 2.2 KB less the 0.8 KB that left mirror.ts, keywriter.ts 1.3 KB less the 0.8 KB that left keypad.ts, cardmodel.ts 1.0, stepslot.ts 1.0, zenhost.ts 1.1). T7's trims: the pad's and the card's confirm pair are one function, and the card's input takes the page's text box rules. The eager bytes are unchanged.
	// Terminal card review fixes (the card's retry and rules, four more refusal words in both languages): 250,973 / 101,531, +1,160 raw / +491 gzipped over T7's 249,813 / 101,040, cap 251,000 / 101,600.
	// Views-core R4 (answer.ts is a lazy chunk shared by the layer, the focus views, and Zen): 251,220 / 101,591, +247 raw over the fix round's 250,973 / 101,531 (the module's own chunk wrapper and exports), cap 251,300 / 101,650.
	// One-tap prompt run: 251,918 / 101,847, +945 raw / +316 gzipped over the review fixes (three refusal words in both languages, the grant carried through the card and Zen host).
	// Merge of views-core R4 and the one-tap run: 252,165 / 101,970 (measured).
	// Views-core R5 (sessionfacts.ts joins the lazy chunks, shared by the focus views and Zen): 252,252 / 102,042, +87 raw / +72 gzipped, cap 252,300 / 102,050.
	// Z5+Z6+eager trim (zensound.ts, zenmusicbar.ts, zenmusic.ts, zenpage.ts, zenunits.ts join the lazy chunks): 269,304 / 108,191 measured, cap 269,319 / 108,206.
	// Eager trim round 2 (zenrows.ts joins the lazy chunks): 269,969 / 108,469 measured, cap 269,984 / 108,484.
	// Zen Z7 layout fixes (the history box scrolled into view when it opens): 270,012 / 108,491 measured, +43 raw / +22 gzipped, cap 270,025 / 108,500.
	// Forwarded dialog cards (feat/link-unattended-dialog-gui): 273,184 / 110,284 measured, +3,178 raw / +1,788 gzipped over the 270,006 / 108,496 the branch base (af392fb) measures: linkdialogs.ts with the card's words and the check of a sender's dialog shape is a lazy chunk, loaded with the first forwarded dialog. Cap = measured + 15.
	const musicChunk = chunks.find((n) => n.startsWith("zenmusic-")); // zenmusic.ts is a chunk of its own: at most 4 KB raw (the spec's Asset budget)
	assert.ok(musicChunk, "the music chunk (createPlayer) is in the build");
	assert.ok(size(musicChunk).length <= 4096, `the music chunk is ${size(musicChunk).length} bytes`);
	// Unit status and notices (S5): 273,184 / 110,304 (measured), the raw size unchanged and +5 gzipped over the 110,299 cap: the chat chunks carry the shared message module, which gained five messages.
	// Zen lines (feat/zen-lines): 278,222 / 113,448 measured, +5,235 raw / +3,306 gzipped over the 272,987 / 110,142 the base measures: 24 more sourced lines with 22 Japanese originals (Japanese text is three bytes a character and hardly compresses), all in the lazy Zen chunk. Cap = measured + 15.
	// A wait for the boss is an alert: 279,979 / 114,077 measured, +1,757 raw / +629 gzipped over the 278,222 / 113,448 above: the wait's dialog and Zen card (gui/waitpanel.ts, the Zen card's branch) are lazy, and the chat chunks carry the shared message module, which gained four messages. Cap = measured + 15.
	// The wait card: Zen text-button rules, the second pair of boss words, the chip line: 279,997 / 114,078, cap 280,000 / 114,092.
	// Head tower H4 (the header button, the head node, the page, the drawer row, the chapter divider, their words): 280,017 / 114,188 (measured). Cap = measured + 15.
	// Head tower H4 review fixes: 280,767 / 114,480 measured (the chat chunks carry the chapter reason words, the head Close in the conversation menu, the news dots). Cap = measured + 33 / + 20.
	// Head tower H5 (the Zen strip: zenhead.ts, headlines.ts, the hooks in zen.ts, and thirteen words in both languages): 290,591 / 118,179 measured, +9.8 KB raw / +3.7 KB gzipped, over the spec's ~4 KB: the strip needs its own lines reducer, fade clock, input, gestures, and history way back, all in the lazy Zen chunk. Cap = measured + 25 / + 20.
	// Head tower H6 (quietForwards, the strip's rest rule, and one word in both languages): 291,348 / 118,456 measured. Cap = measured + 25 / + 20.
	// Merge of the head tower into main (0.58.0): 293,235 / 119,191 measured, the head's figures plus the wait alert's. Cap = measured + 15 / + 19.
	// Head polish (after 0.58.0: the key's message, the strip's lift and away swaps in the lazy Zen chunk): 293,458 / 119,242 measured, +223 / +51 over the merge figure. Cap = measured + 15.
	assert.ok(chunks.length >= 1 && total(chunks, (n) => size(n).length) <= 293_473 && total(chunks, gz) <= 119_257, `the chat chunks are ${total(chunks, (n) => size(n).length)} bytes (${total(chunks, gz)} gzipped)`);
	// The stylesheet's figure was 22 KB / 6 KB; 0.4.0 raised it by 0.1 KB for the comms anchor highlight, the receive-only strip, and the title link;
	// 0.5.0 to 24.6 KB / 6.7 KB for the composer, the phone layout with its touch targets and safe-area insets, and the pairing tile.
	// and to 26 KB / 7 KB for the read-only question panel and the net log that folds on a phone; 0.5.1 to 26.5 KB raw for the queue line in the dialogs.
	// 0.6.0 to 27.5 KB / 7.25 KB for the answer panel's toggles, fields, and Send.
	// 0.7.0 to 29 KB / 7.7 KB for the terminal tile: its 16 colours as text and background classes, the attributes, the bar, and the scroll box.
	// And to 30.5 KB / 8 KB for the key pad: its key caps and rows, 44 px targets on a phone, the digits' fold, and the confirm.
	// 0.8.0 to 32 KB / 8.25 KB for the documents: the parchment badge on a plate, the dossier's list, and the tile's bar, frame, and text (about 1.5 KB,
	// 0.3 KB gzipped). The Phase 3 plan proposed 31 KB / 8.25 KB: this is 1 KB raw over it, within its gzip figure.
	// 0.13.0 to 32.7 KB / 8.375 KB for the opening tile: the base view's button row, the folder path and grid, the form fields, and the open button's colour (about 0.7 KB, 0.1 KB gzipped).
	// 0.14.0 to 33.3 KB / 8.475 KB for the `/` menu above the composer: its box, rows, the lit row, and the name and description (about 0.6 KB, 0.1 KB gzipped).
	// 0.15.0 to 34.05 KB / 8.625 KB for the opening buttons: a squad's small + Member, the base card's row, and the dashed + New base card, and short form tiles keeping their own height (about 0.7 KB, 0.15 KB gzipped).
	// 0.17.0 to 34.25 KB / 8.67 KB for the close buttons; 0.17.2 to 34.9 KB / 8.85 KB for runs of chat messages that show their avatar once and the folding location bar; 0.17.3 to 35.2 KB / 8.9 KB for the motion of new messages;
	// 0.18.0 to 35.5 KB / 9.1 KB for the Nerd Font symbols face of a pane's screen; 0.18.1 to 36.6 KB / 9.3 KB for the confirm dialog and the modes;
	// 0.18.2 to 37.2 KB / 9.45 KB for the comms header's two rows on a phone and its one-line name; 0.19.0 to 38.25 KB / 9.65 KB for the todo list;
	// 0.20.0 to 40 KB / 10.05 KB for thumbnails, the lightbox, the queue under the chat, and a squad name kept to one line.
	// 0.21.0 to 40.6 KB / 10.2 KB for the reminder and sound switches (their dot per state) and a phone's header in three rows.
	// 0.23.0 to 42.1 KB / 10.5 KB for the header's popovers (the sound panel and the finished list with its rows) and the Finished button beside the HUD alert, kept on one line on a 320 px phone.
	// 0.24.0 to 43.6 KB / 10.85 KB for a dialog's Enlarge (the wide dock in the middle of the window), a header that tightens and wraps between a
	// phone and a wide screen, and a terminal that takes the keyboard: its ring, lit edge, flash per key, pulsing note, and the hidden text box.
	// 0.25.0 to 45 KB / 11.1 KB for the monitors bar: its summary, and each monitor's mark, state, and last line.
	// 0.25.1 to 45.1 KB / 11.12 KB for a phone's composer (no blank note line under Send, + on Send's row) and Open comms centred in its touch box.
	// 0.26.0 to 45.7 KB / 11.2 KB for a phone's full-screen session (fixed comms and tiles over the visual viewport, the back button) and Quit on the map.
	// 0.26.1 to 46.35 KB / 11.3 KB for Quit tower, a phone's Info and full-screen dossier, and a tower's squads in its dossier.
	// 0.26.2 to 11.35 KB gzipped: a phone hides only a dialog's Enlarge, not the base map that shares its .zoom class.
	// 0.27.0 to 47.5 KB / 11.56 KB for the page's idle motion: the packets' dots, the still signs a calm page shows in place of each endless animation, the second name of each restartable keyframe set (`-b`, so a one-shot animation replays without a layout read), and per-kind stand-in heights for the log's entries.
	// 0.27.0 to 47.6 KB / 11.6 KB gzipped: the desktop composer keeps its column when a long URL is typed.
	// Unreleased to 47.65 KB: the own-words box is a textarea that grows with its lines (Shift+Enter breaks one).
	// 0.28.0, with the textarea, to 48.1 KB / 11.7 KB for the secret panel's steps, destination, and masked field.
	// The secret's masked field is a text input drawn as dots by CSS (never type=password), to 48.2 KB.
	// Unreleased to 48.7 KB / 11.8 KB gzipped for the paired devices list on the pairing tile, then to 50 KB / 12 KB for the commanding mark's colour, badge, and glow, and to 51.8 KB / 12.4 KB for the phone drawer.
	// Unreleased to 52 KB / 12.45 KB for the base's Stash beside its Quit and the Stashed list's rows.
	// Unreleased (net sidecar) to 52.2 KB for the agent badge.
	// Unreleased (comfort) to 58 KB / 13.1 KB gzipped: every colour a palette token (color-mix of a token is longer than the literal it replaced), the location bar with the legend, the footer, masonry rows, and Quit shown on hover.
	// Unreleased (comfort) to 60 KB / 13.45 KB for the comfort effects: a card's lift and its glow in a new state, presses, the tethers' arrowheads and their flow (resting when the page calms), selection and scrollbar colours.
	// Unreleased (comfort) to 62.6 KB / 13.95 KB for the timeline's marks, rows, and hover names, a card's clock, todo, and step marks, and the overview, less the net log's rules.
	// Unreleased (calm header) to 63.4 KB / 14.1 KB: the totals as one strip, the settings button and panel, the map's actions in the location bar.
	// Unreleased to 63.45 KB: the work's gauge (layer.ts watches its width) and the work positioned for it.
	// Unreleased to 63.7 KB / 14.13 KB: a phone's comms play their entrance themselves, not on their view (whose transform held them under the HUD), and "opening the channel" covers the screen.
	// Unreleased to 14.14 KB gzipped: the drawer's current unit marked on both edges.
	// Unreleased to 63.95 KB / 14.2 KB: the drawer's finished card following the finger and sliding out when dismissed.
	// Unreleased to 64.05 KB / 14.25 KB: the "+ Main" button in a tower's comms head, and a fifth column for it on a phone.
	// Unreleased to 64.45 KB / 14.3 KB: the drawer's map link and Dismiss finished row.
	// Unreleased to 71 KB / 15.45 KB: the folder picker (toolbar and breadcrumb, shortcuts, the columns, the one column of a narrow window); and
	// Unreleased to 68 KB / 14.95 KB: the deploy panel (bar, step list, running pulse, finish and failure tints, its keyframes).
	// Unreleased to 75.1 KB / 16.35 KB gzipped (Straw Link 75 KB / 16.3 KB, the session view's Quit the rest): Straw Link (the teammates' bases, the notices, the team settings tile with its roster, invite, and join forms).
	// Unreleased to 71.2 KB / 15.55 KB: the session view's Quit in the comms header (desktop and phone grid).
	// Unreleased (queue Edit, on top of the drawer's) to 76.65 KB / 16.6 KB gzipped: the queued row's clamp on a box inside the padded row and the queue's Edit line.
	// Unreleased to 76.2 KB / 16.5 KB: the phone drawer's tower row, its Quit, the map link's foot, and no selection in the drawer.
	// Unreleased to 71.75 KB / 15.65 KB gzipped: the trust question (its groups, folded items, and the deploy step's inline copy).
	// Unreleased to 72 KB / 15.7 KB gzipped: the trust question names its folder whole, in the panel and in the deploy step.
	// Merged with the queue's Edit: 77.5 KB / 16.8 KB gzipped in all.
	// Unreleased to 80.2 KB / 17.4 KB gzipped: the phone's tap targets (one media block: 44 px boxes, chips drawn inside them, the queue and trust rows, the composer's 48 px keys; +2.7 KB / 0.6 KB).
	// Unreleased (sb server B5, GUI) to 80.6 KB / 17.5 KB gzipped: the tower notices' rows (.tower-notices).
	// GUI visual pass (sb server B5) to 81.75 KB / 17.7 KB gzipped: the notices wrap and read at AA, the queue chip, the comms' notices and the terminal's sentence, the wrapping state line, and a tower's phone header on two rows.
	// Review RV-F001 to 81.9 KB: the crash note of a boss turn (.boss-flag).
	// GUI fix pass (sb server B6) to 82.6 KB / 17.8 KB gzipped: the ally runs' chips, the workspace view's notices, the folded header of a teammate's message, and the foot's shrinking column.
	// Tower memory (T3) to 83.45 KB / 18 KB gzipped: the memory panel's lists, inputs, and struck-through ended waits (.tower-memory, .tmem).
	// Boss conversation (T4) to 84,319 bytes / 18.13 KB gzipped: the box above the composer, its buttons, the dividers, and the event-run chips.
	// Remote app entry (D25) to 82.7 KB / 17.85 KB gzipped: the code to type in an installed app, under the pairing QR (.pair-code).
	// Merge of the remote app entry (D25) with T4 to 18.14 KB gzipped: .pair-code beside the conversation's rules.
	// Ended bar (sb server B6) to 84.5 KB / 18.2 KB gzipped: the one-line bar that replaces the composer.
	// Phone terminal keyboard (sb server B6) to 84.8 KB / 18.25 KB gzipped: the Keyboard button, the hidden sink, and the typing state of the mirror.
	// Wi-Fi access, the page (L7) to 86,900 bytes / 18.6 KB gzipped: the tabs, the waiting requests with the number field, the certificate step, and the Wi-Fi pairing (.lan).
	// Review RVL7 to 87,100 bytes / 18.65 KB gzipped: the Deny that keeps its width, the Wi-Fi buttons that are not uppercased, and the header's waiting-request notice that wraps on a narrow screen.
	// GUI quick fixes (step 1) to 88,100 bytes / 18.85 KB gzipped: the themed text boxes and menus, the server facts grid, the filled selected pair tab, and the padded conversation bar.
	// The Geek view, per device (step 2) to 93,200 bytes / 20.1 KB gzipped: its token block (the whole palette again), the rules that turn off motion, gradients, and glow, the state tags, the switches' words, the inverse-video choices, the forced-colors block, and the settings' three-way control.
	// Phone layout (step 4) to 96,800 bytes / 20.9 KB gzipped: the `⋯` menus, the one-line conversation bar, the queue's fold row, the map without crumbs, no avatar gutter, the squads' unit rows, and the drawer's named tower row, all in one phone block ("A phone's menus and layout").
	// Settings page (step 5) to 98,600 bytes / 21.2 KB gzipped: the page's groups, rows, and disclosures, the devices' grid rows, and the Wi-Fi tab's and the Phone block's rules for a 360 px screen (less the popover's and the sound panel's).
	// GUI acceptance fixes to 100,900 bytes / 21.65 KB gzipped: Dismiss on its own row, the question card's scroll cue, the 360 px block (two-line conversation bar, one-row composer, Geek brand), the drawer's tint and chevron, Geek's disabled controls and tick ring, and the forced-colors rules.
	// Cancel (fix/ask-cancel) to 101,200 bytes: `.ask-cancel` and its place in the touch and press rules.
	// The connection overlay to 102,200 bytes / 21.9 KB gzipped: `.connect` (the modal overlay over the page, its card, ring, and Try again) and the ring's rest in calm and Geek.
	// The value zen (Zen step Z1) to 102,400 bytes: `.zen-back`, the header button hidden outside Standard-while-away.
	// The Zen layer (Z3) to 105,800 bytes / 23.2 KB gzipped: the first-frame block in style.css (about 0.3 KB) and gui/zen.css (2.9 KB, loaded with the Zen chunk; Z4 restyles it).
	// The Reload link in the overlay (fix/connect-stuck) to 102,900 bytes / 22.0 KB gzipped (with Z1's .zen-back): `.connect-reload` (revealed after 10 s by a step), its keyframes, the reduced-motion exception, and forced colors.
	// Zen Z4 to 116,400 bytes / 25.65 KB gzipped: gui/zen.css grows from 2.9 KB to 12.7 KB raw (3.4 KB gzipped): the ink tokens, the drift and the breathing circle's washes, the card's slow entrance and its dissolve, the lofi answer card and composer, the corner menu, and the forced-colors and reduced-motion rules; style.css grows by the first-frame ring (about 0.9 KB).
	// Zen feedback round to 117,500 bytes / 25.8 KB gzipped: the card's two boxes and their eased height, the log's overscroll rules, the pill, the ripples' canvas, and the Esc line.
	// Zen terminal layer to 119,343 bytes / 25,983 gzipped (+1.8 KB raw / +0.2 KB gzipped): the layer's grid, bar, button, host rules, and the quiet Esc line in gui/zen.css.
	// Several questions merged over the terminal layer: 123,314 / 26,630, cap 123,400 / 26,700.
	// Zen polish (the pad confirm's two buttons in Zen, the fade rule): 124,108 / 26,719, cap 124,200 / 26,800.
	// Several questions in Zen (feat/zen-multi-question) to 118,200 bytes / 26 KB gzipped: gui/zen.css grows by the scroller, the faded blocks, and their forced-colors and reduced-motion rules (117,430 / 25,752 to 118,150 / 25,926).
	// Its fix round to 120,300 bytes / 26.3 KB gzipped: the card's column down to the panel (the send row never given up), the folded lines and their summaries, the soft edges, and the deeper foot while more lies below (118,150 / 25,926 to 120,228 / 26,240).
	// Fix round 2 to 121,400 bytes / 26.5 KB gzipped: the short-window block (max-height 560px) and the dropped lines (121,372 / 26,403).
	// Fix round 3 to 121,600 bytes / 26.55 KB gzipped: the 340px rule for a lone question's context and the open block's row size (121,500 / 26,429).
	// Integration of fix/zen-polish and feat/zen-multi-question to 124,400 bytes / 26.9 KB gzipped (measured 124,236 / 26,746): the confirm pair, the questions' scroller and edges, and the 340px rule.
	// Terminal card T4 (the card in the dock: a dialog's box shared, the confirm pair's box for the mask and Send, the phone sheet, the Geek flat surface; and Zen's ink skin in gui/zen.css): 127,856 / 27,410, +3,620 raw / +664 gzipped over the integration's 124,236 / 26,746, cap 127,900 / 27,450. The spec aimed at +1.5 KB / +0.4 KB; the three skins and the sheet took more, with the dialog's and the pad's rules already shared.
	// Zen's yellows (the ochre tokens, the muted mirror, the paper tokens): 124,740 / 26,839, cap 124,800 / 26,900.
	// Merge of the terminal card's T4 with main's Zen yellows: 128,119 / 27,465, cap 128,150 / 27,500.
	// Z5+Z6 (zen.css music and sound rows) took the stylesheet to 131,608 / 27,977 (measured at 314cad1 and after the eager-entry trim), cap +15.
	// Zen Z7 layout fixes (the ring-less focus, the log's pill box, unsqueezed choices, the open history's rules, the phone and 900 px tightening, the strip's phone place): 133,483 / 28,223 measured, +1,875 raw / +246 gzipped, cap 133,500 / 28,240.
	// Z-D13 (Zen keeps breathing at rest, the faint breath behind the companion's log, the half-minute tide and wander, the companion without boxes): 134,446 / 28,449 measured, +963 raw / +226 gzipped, cap 134,461 / 28,464.
	// Z-D14 (a lone question's rows keep their height, the 44 px own-answer box, the long question as text): 134,710 / 28,501 measured, cap 134,725 / 28,516.
	// Z-D15 (the visual language: choices as lines with a dot, the seal only for the keys, overlays on a blurred veil with no panel, fields as one line; a block at the end of zen.css over the older rules, which loads with the Zen chunk only): 140,977 / 29,417 measured, +6,267 raw / +916 gzipped, cap 140,992 / 29,432.
	// Z-D16 and the Z-D15 review fixes (the terminal layer's pair as words, the veil that takes the press, the chosen dot under forced colours, dead rules dropped): 141,185 / 29,423 measured, cap 141,200 / 29,438.
	// Forwarded dialog cards (feat/link-unattended-dialog-gui): 134,117 / 28,348 measured, +617 raw / +108 gzipped over the cap above (the branch base is within it): the card sits flat around the question panel, keeps Send answer in view over a long list, and words how it ended in a readable colour. Cap = measured + 15.
	// Unit status and notices (S5): 134,774 / 28,446 (measured), +642 raw / +83 gzipped over the 134,132 / 28,363 cap: the ally base's unit list and a notice's row in style.css.
	// Merge of feat/link-unattended with 0.55.0: 142,426 / 29,639 measured (Zen's Z-D16 sheet plus the dialog cards and the unit list), cap = measured + 15.
	// Zen lines (feat/zen-lines): 142,568 / 29,659 measured, +142 raw / +20 gzipped over the 142,426 / 29,639 above: one rule for the small Japanese original under a line's source (gui/zen.css). Cap = measured + 15.
	// Head tower H4 review fixes: 146,334 / 30,310 measured (the news dots, the head Info hidden). Cap = measured + 16 / + 20.
	// Zen lines review (ZL-F001): 142,698 / 29,684 measured, +130 raw / +25 gzipped: balanced wrapping for the line and its Japanese original, so a phone leaves no one-character orphan. Cap = measured + 15.
	// A wait for the boss is an alert: 143,023 / 29,738 measured, +325 raw / +54 gzipped over the 142,698 / 29,684 above: the wait panel's rules (gui/style.css) and the centring of its buttons in Zen (gui/zen.css). Cap = measured + 15.
	// Head tower H4 (the crown button and dot, the head node, the asks chips, the chapter divider, the drawer row, Geek and forced-colours rules): 146,027 / 30,256 (measured). Cap = measured + 15.
	// Head tower H5 (the strip in gui/zen.css: the lines and their fade, the folded and unfolded input, the history's way back, phone, reduced motion, forced colours; the head page's gold plate in style.css): 151,425 / 31,081 (measured). Cap = measured + 15.
	// Head tower H6 (the Zen history's quiet forward rows, the Chinese line wrap, reduced motion for the head's lines, Geek's flat head plate; the H5 review fixes' history veil and rules since the figure above): 152,861 / 31,315 measured. Cap = measured + 15.
	// Merge of the head tower into main (0.58.0): 153,316 / 31,385 measured, the head's figures plus the wait alert's Zen buttons. Cap = measured + 14 / + 15.
	// Head polish (after 0.58.0: the compact head node, the lines' --fade/--lift swap, the away rules for the mindfulness line and the link, the key's rules): 154,415 / 31,676 measured, +1,099 / +291 over the merge figure. Cap = measured + 15.
	assert.ok(total(css, (n) => size(n).length) <= 154_430 && total(css, gz) <= 31_691, `the stylesheet is ${total(css, (n) => size(n).length)} bytes (${total(css, gz)} gzipped)`);
});

// The Zen rows of the keymap exist only because the Zen chunk's entry imports zenrows.ts for its side effect: nothing else loads them in the page, so dropping that "unused" import leaves Enter, H, [, ], and the palette key dead while every other test stays green.
test("the Zen chunk's entry imports zenrows.ts, which registers the Zen keymap rows", () => {
	assert.match(readFileSync(join(root, "gui/zenchunk.ts"), "utf8"), /^import\s+["']\.\/zenrows\.ts["'];?/m);
	assert.match(readFileSync(join(root, "gui/zenrows.ts"), "utf8"), /KEYMAP\.zen\s*=|KEYMAP\[["']zen["']\]\s*=/);
});
