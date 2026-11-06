import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkAlert } from "../src/link/holder.ts";
import type { Net } from "../src/net.ts";

// What the boss is asked outside a unit's own dialog, as Zen's items (gui/cardalerts.ts; docs/specs/2026-11-01-zen-view.md, Link cards): a teammate's tower waiting on Allow or Deny, a dialog an unattended device forwarded,
// a pair request, and a memory proposal. Each is read from the state the server holds (the snapshot, the pending list), so what the server settled is gone from the list and the item goes with it.
const { cardAlerts } = await import("../gui/cardalerts.ts");
const { alertsOf } = await import("../gui/alerts.ts");
const { createZen } = await import("../gui/zenmodel.ts");

const NOW = 5_000_000;
const CONFIRM = { dialogId: "dc1", team: "t1", from: "dev-b", fromLabel: "Mei's Mac", fromShort: "b1c2", digest: "e".repeat(64), tool: "bash", args: "rm -rf build", tower: "sb-tower-w", at: NOW - 60_000 };
const SELECT = JSON.stringify({ select: { title: "Deploy where?", choices: [{ label: "Staging" }, { label: "Production" }] } });
const dialog = (o: Partial<LinkAlert["data"]> = {}): LinkAlert => ({ id: "dlg-1", kind: "dialog", level: "warning", team: "t1", teamName: "Harbor team", data: { device: "dev-b", dialogId: "dd1", digest: "f".repeat(64), dialog: SELECT, label: "Mei's Mac", short: "b1c2", owner: "ops-main", ...o } });
const PROPOSAL = { id: "P1", op: "add" as const, kind: "standing" as const, text: "Never deploy on Fridays" };
const net = (o: { confirms?: unknown[]; alerts?: LinkAlert[]; proposals?: unknown[]; control?: boolean } = {}): Net => ({
	bases: [{ id: "w", label: "Harbor", mark: "idle", tower: { name: "tower", mark: "idle", key: "t", control: o.control ?? true, subs: [], service: { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev: 7, standing: 0, decisions: 0, waits: 0, bossWaits: [], proposals: o.proposals ?? [] } } as never }, tabs: [], outposts: [], outside: [] }],
	link: { allies: [], units: [], alerts: o.alerts ?? [], confirms: o.confirms ?? [] } as never,
}) as Net;
const PAIR = { id: "ab12cd34ef56", label: "Mei's iPhone", peer: "192.168.1.20", iface: "en0", age: "20 s", ageMs: 20_000 };

test("a confirm a teammate's tower asked is an item of the server's own list: its key is the dialog's, it waits since the request, and the card carries the request whole", () => {
	const [a] = cardAlerts(net({ confirms: [CONFIRM] }), NOW, {});
	assert.ok(a);
	assert.deepEqual([a.key, a.mark, a.since, a.name], [`link-confirm\u001fdc1`, "waiting", NOW - 60_000, "Mei's Mac"]);
	assert.deepEqual(a.card, { kind: "confirm", confirm: CONFIRM });
	assert.equal(a.pending, undefined, "it is not a unit's dialog: the card draws its own Allow and Deny");
});

test("a forwarded dialog that asks is an item with its question as a panel takes it; one answered, closed, or unreadable is none", () => {
	const [a] = cardAlerts(net({ alerts: [dialog()] }), NOW, {});
	assert.ok(a);
	assert.equal(a.key, `link-dialog\u001fdlg-1`);
	assert.deepEqual(a.pending?.answer?.select?.title, "Deploy where?");
	assert.deepEqual([a.pending?.answer?.dialog, a.pending?.answer?.digest], ["dd1", "f".repeat(64)]);
	assert.deepEqual(a.card, { kind: "dialog", device: "dev-b", dialogId: "dd1", digest: "f".repeat(64), line: "Mei's Mac (b1c2) in team Harbor team asks a question (ops-main)." });
	assert.deepEqual(cardAlerts(net({ alerts: [dialog({ answered: 1 })] }), NOW, {}), [], "sent from here: waiting for the device to close it");
	assert.deepEqual(cardAlerts(net({ alerts: [dialog({ closed: "local" })] }), NOW, {}), [], "closed at the device");
	assert.deepEqual(cardAlerts(net({ alerts: [dialog({ closed: "remote" })] }), NOW, {}), [], "closed by a controller");
	assert.deepEqual(cardAlerts(net({ alerts: [dialog({ dialog: "{not json" })] }), NOW, {}), [], "a question no panel can draw stays in the Link notices");
});

test("the other Link notices are not items: a join request (its words are checked in Standard), a fork, an unreachable relay, a held message", () => {
	const kinds = (["join-request", "fork", "mismatch", "unreachable", "inbox", "held", "served", "notice"] as const).map((kind): LinkAlert => ({ id: kind, kind, level: "warning", team: "t1", teamName: "Harbor team", data: { label: "x", short: "y", count: 2, reason: "r", minutes: 3, what: "w", unit: "u", text: "t" } }));
	assert.deepEqual(cardAlerts(net({ alerts: kinds }), NOW, {}), []);
});

test("a pair request is an item by its id, waiting since its age; none are given for a paired device's page", () => {
	const [a] = cardAlerts(net(), NOW, { pairs: [PAIR] });
	assert.ok(a);
	assert.deepEqual([a.key, a.mark, a.since, a.name], [`pair\u001fab12cd34ef56`, "waiting", NOW - 20_000, "Mei's iPhone"]);
	assert.deepEqual(a.card, { kind: "pair", request: PAIR });
	assert.deepEqual(cardAlerts(net(), NOW, { pairs: [] }), []);
	assert.deepEqual(cardAlerts(net(), NOW, {}), []);
});

test("a memory proposal is an item of its tower: the key names the workspace and the proposal, the card carries the rev the snapshot read, and a tower the page cannot control raises none", () => {
	const [a] = cardAlerts(net({ proposals: [PROPOSAL] }), NOW, {});
	assert.ok(a);
	assert.deepEqual([a.key, a.ws, a.unit, a.role, a.mark], [`proposal\u001fw\u001fP1`, "w", "t", "tower", "waiting"]);
	assert.deepEqual(a.card, { kind: "proposal", ws: "w", tower: "t", proposal: PROPOSAL, rev: 7 });
	assert.equal(a.closed, false);
	assert.equal(cardAlerts(net({ proposals: [PROPOSAL], control: false }), NOW, {})[0]!.closed, true);
});

test("Standard's alerts are unchanged: alertsOf carries none of these, so the dock never gets a dialog it cannot draw", () => {
	const all = alertsOf(net({ confirms: [CONFIRM], alerts: [dialog()], proposals: [PROPOSAL] }), NOW);
	assert.deepEqual([...all.keys()].filter((k) => /^(link-|pair|proposal)/.test(k)), []);
});

test("the model takes them as items, and one the server no longer lists was settled elsewhere: the knock and the line", () => {
	let t = NOW;
	const z = createZen({ now: () => t, typing: () => false, touched: () => false });
	const withCard = new Map(cardAlerts(net({ confirms: [CONFIRM] }), t, {}).map((a) => [a.key, a]));
	const r = z.update(withCard);
	assert.equal(r.screen.kind, "item");
	const gone = z.update(new Map());
	assert.deepEqual([gone.sound, (gone.screen as { outcome?: string }).outcome], ["knock", "elsewhere"]);
});

test("a rest ends early when the question behind a card changes: another forwarded dialog under the same alert id", () => {
	let t = NOW;
	const z = createZen({ now: () => t, typing: () => false, touched: () => false });
	const first = new Map(cardAlerts(net({ alerts: [dialog()] }), t, {}).map((a) => [a.key, a]));
	assert.equal(z.update(first).screen.kind, "item");
	z.skip();
	t += 3000;
	assert.equal(z.update(first).screen.kind, "companion", "resting");
	const other = new Map(cardAlerts(net({ alerts: [dialog({ dialogId: "dd2", digest: "a".repeat(64) })] }), t, {}).map((a) => [a.key, a]));
	assert.equal(z.update(other).screen.kind, "item", "a new question is not the one put aside");
});
