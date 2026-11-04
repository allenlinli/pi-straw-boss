import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fieldsOf, withoutField } from "../src/header.ts";
import { World } from "./fakes.ts";

// `head=yes` belongs to the head identity alone (docs/specs/2026-11-04-head-tower.md, Forwarding, and the answers; review HH2-F001): a workspace that carries `sb_head` or a pane whose `sb_role` token says `head` does not
// make its session the head tower. The identity is the value of the workspace's `sb_head` token.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const sentFrom = (id: string) => world.broker.delivered.filter((d) => d.from === id).map((d) => ({ to: d.to, line: d.message }));

async function pair() {
	const towerA = world.tower("tower-wA", "wA:t7", "wA:p7");
	const towerB = world.tower("tower-wB", "wB:t7", "wB:p7");
	await Promise.all(world.agents.map((agent) => agent.start()));
	world.broker.delivered.length = 0;
	return { towerA, towerB };
}

test("a sender in a workspace that carries sb_head is the head tower only when its id is the token's value", async () => {
	const { towerA } = await pair();
	world.herdr.workspace("wA").tokens.sb_head = "sb-head";
	await towerA.tool("tower_send", { message: "from an impostor", workspace: "wB" }).catch(() => undefined);
	const [sent] = sentFrom("tower-wA");
	assert.ok(sent, "the message went out");
	const f = fieldsOf(sent.line)!;
	assert.equal(f.head, undefined, sent.line);
	assert.equal(f.workspace, "Alpha", sent.line);
	// The same workspace, with the token naming this very identity: the head tower.
	world.herdr.workspace("wA").tokens.sb_head = "tower-wA";
	world.broker.delivered.length = 0;
	await towerA.tool("tower_send", { message: "from the head", workspace: "wB" }).catch(() => undefined);
	const g = fieldsOf(sentFrom("tower-wA")[0]!.line)!;
	assert.equal(g.head, "yes");
	assert.equal(g.workspace, "head");
});

test("a recipient whose pane token says head is the head tower only when its id is the workspace's sb_head", async () => {
	const { towerA } = await pair();
	world.herdr.pane("wB:p7").tokens.sb_role = "head";
	await towerA.tool("tower_send", { message: "hello", workspace: "wB" });
	const f = fieldsOf(sentFrom("tower-wA")[0]!.line)!;
	assert.doesNotMatch(f.to!, /head tower/);
});

test("withoutField takes a field out of the leading header only: quoted values keep their `]` and `relay=`, and the text under the header is never read", () => {
	const text = '[straw net from="a] relay=boss:x" id=h role=tower relay=boss:e1 kind=tower_send to="y" reply=none] relay=boss:e2 body ]';
	assert.equal(withoutField(text, "relay"), '[straw net from="a] relay=boss:x" id=h role=tower kind=tower_send to="y" reply=none] relay=boss:e2 body ]');
	assert.equal(withoutField("[straw net id=h kind=x]", "relay"), "[straw net id=h kind=x]");
	assert.equal(withoutField("no header relay=boss:e1", "relay"), "no header relay=boss:e1");
	assert.equal(withoutField("[straw net id=h relay=boss:a relay=boss:b]", "relay"), "[straw net id=h]");
});
