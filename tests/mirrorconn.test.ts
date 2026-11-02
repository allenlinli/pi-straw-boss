import assert from "node:assert/strict";
import { mock, test } from "node:test";

// The connection to one terminal's mirror (gui/mirrorconn.ts), without a screen: the rows the frames set, the phases and the state the pad may
// act on, and one attach per key however many watch it, here and through the tile layer (gui/mirror.ts `watch`, `embed`).

/** The few DOM calls the tile layer makes. */
class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	classes = new Set<string>();
	classList = { toggle: (c: string, on?: boolean) => ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)), contains: (c: string) => this.classes.has(c), remove: (c: string) => this.classes.delete(c) };
	onclick: (() => void) | null = null;
	value = "";
	scrollTop = 0;
	scrollHeight = 0;
	clientWidth = 400;
	parent: El | undefined;
	addEventListener() {}
	focus() {}
	blur() {}
	getBoundingClientRect() {
		return { left: 0, bottom: 0 };
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	append(...kids: (El | string)[]) {
		for (const kid of kids) if (kid instanceof El) kid.parent = this;
		this.kids.push(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [];
		this.append(...kids);
	}
	get children(): El[] {
		return this.kids.filter((k): k is El => k instanceof El);
	}
	get lastElementChild(): El | null {
		return this.children.at(-1) ?? null;
	}
	remove() {
		this.parent?.kids.splice(this.parent.kids.indexOf(this), 1);
	}
	get textContent(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
	}
	set textContent(value: string) {
		this.kids = [value];
	}
}
const listeners: (() => void)[] = [];
const doc = { hidden: false, createElement: () => new El(), addEventListener: (_: string, f: () => void) => listeners.push(f) };
Object.assign(globalThis, { document: doc, ResizeObserver: class { observe() {} }, requestAnimationFrame: (f: () => void) => f() });
const { mountConns, MAX_ROWS } = await import("../gui/mirrorconn.ts");
const { mountTerminals } = await import("../gui/mirror.ts");
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

type Reply = { ok: boolean; status: number; body: Record<string, unknown> };
const fine: Reply = { ok: true, status: 200, body: {} };
function world(answer: (key: string, body: Record<string, unknown>) => Reply = () => fine) {
	const posts: [string, Record<string, unknown>][] = [];
	let hello = JSON.stringify({ stream: "s1" });
	const post = (key: string) => async (action: string, body: Record<string, unknown>) => (posts.push([`${action}:${key}`, body]), answer(key, body));
	return { posts, post: post as never, stream: () => hello, newStream: (s: string) => (hello = JSON.stringify({ stream: s })), mirrorPosts: () => posts.filter(([a]) => a.startsWith("mirror:")).map(([a, b]) => `${a}:${b.on}`) };
}
const frame = (f: Record<string, unknown>) => JSON.stringify({ key: "K", ...f });

test("the rows model: a whole frame sets the rows, a diff only the rows it names, the row count grows and shrinks, and a bad entry is dropped", async () => {
	const w = world(), conns = mountConns(w);
	const seen: { rows: string[]; f: unknown; size: boolean }[] = [];
	const { conn, stop } = conns.join("K", { rows: (rows, f, size) => void seen.push({ rows: [...rows], f, size }) });
	try {
		conns.frame(frame({ rows: 3, cols: 40, whole: true, set: [[0, "a"], [1, "b"], [2, "c"]] }));
		assert.deepEqual(conn.rows, ["a", "b", "c"]);
		conns.frame(frame({ rows: 3, cols: 40, set: [[1, "B"]] }));
		assert.deepEqual(conn.rows, ["a", "B", "c"], "a diff keeps the rows it does not name");
		conns.frame(frame({ rows: 5, cols: 40, set: [[4, "e"]] }));
		assert.deepEqual(conn.rows, ["a", "B", "c", "", "e"], "new rows start empty");
		conns.frame(frame({ rows: 2, cols: 40, set: [[1, "x"]] }));
		assert.deepEqual(conn.rows, ["a", "x"], "fewer rows drop the last ones");
		conns.frame(frame({ rows: 2, set: [[5, "out"], [-1, "neg"], [0.5, "frac"], [1, 7], [0, "A"]] as never }));
		assert.deepEqual(conn.rows, ["A", "x"], "an index out of range, a fraction, and a non-string row change nothing");
		conns.frame(frame({ rows: 5000, whole: true, set: [] }));
		assert.equal(conn.rows.length, MAX_ROWS, "the row count is clamped");
		conns.frame(frame({ rows: 2, set: [[0, "p"], [1, "q"]] }));
		conns.frame(frame({ set: [[0, "no count"]] }));
		assert.deepEqual(conn.rows, [], "a frame without a row count leaves no rows, as the tile's does");
		assert.equal(seen.at(-1)!.rows.length, 0);
	} finally {
		stop();
	}
});

test("the rows listener hears each frame with whether the width changed; a hidden frame empties the rows and says so with a frame of no rows", async () => {
	const w = world(), conns = mountConns(w);
	const seen: { rows: string[]; f: { rows?: number; hidden?: boolean }; size: boolean }[] = [];
	const phases: string[] = [];
	const { conn, stop } = conns.join("K", { rows: (rows, f, size) => void seen.push({ rows: [...rows], f, size }), state: (_, c) => void phases.push(c.phase) });
	try {
		conns.frame(frame({ rows: 1, cols: 80, whole: true, set: [[0, "w"]] }));
		conns.frame(frame({ rows: 1, cols: 80, set: [[0, "x"]] }));
		conns.frame(frame({ rows: 1, cols: 100, set: [[0, "y"]] }));
		conns.frame(frame({ rows: 1, set: [[0, "z"]] }));
		assert.deepEqual(seen.map((s) => s.size), [true, false, true, false], "whole, same width, a new width, no width given");
		assert.equal(conn.cols, 100, "the width given last is kept");
		conns.frame(frame({ hidden: true }));
		assert.deepEqual(conn.rows, []);
		assert.equal(seen.at(-1)!.f.rows, 0);
		assert.equal(conn.hidden, true);
		assert.equal(conn.phase, "hidden");
		assert.deepEqual(phases, ["live", "live", "live", "live", "hidden"], "each frame tells the state once, after its rows");
		conns.frame(frame({ rows: 1, set: [[0, "back"]] }));
		assert.equal(conn.hidden, false);
		assert.equal(conn.phase, "live");
	} finally {
		stop();
	}
});

test("state(): live with fresh frames, off when stale, parked, or ended, hidden for a secret; the check tells the watchers once a second while a tab shows", async () => {
	mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
	const w = world(), conns = mountConns(w);
	const told: string[] = [];
	const { conn, stop } = conns.join("K", { state: (s) => void told.push(s) });
	try {
		assert.equal(conn.state(), "off", "no frame yet");
		conns.frame(frame({ rows: 1, set: [[0, "a"]] }));
		assert.equal(conn.state(), "live");
		told.length = 0;
		mock.timers.tick(1000);
		assert.deepEqual(told, ["live"], "the check ran once");
		mock.timers.tick(2001);
		assert.equal(conn.state(), "off", "3 s without a frame is stale");
		assert.equal(told.at(-1), "off");
		conns.frame(frame({ hidden: true }));
		assert.equal(conn.state(), "hidden");
		conns.frame(frame({ ended: "gone" }));
		assert.equal(conn.state(), "off");
		assert.equal(conn.hidden, true, "an ended frame leaves the screen hidden, as the tile did");
	} finally {
		stop();
		mock.timers.reset();
	}
});

test("a refused attach turns into the refused phase with the server's reason; not found and pane_closed also end the watchers; joining again retries", async () => {
	let reply: Reply = { ok: false, status: 409, body: { error: "not_live", reason: "This session is no longer live in a pane." } };
	const w = world(() => reply), conns = mountConns(w);
	const ends: string[] = [];
	const { conn, stop } = conns.join("K", { end: () => void ends.push("end") });
	try {
		await settle();
		assert.equal(conn.phase, "refused");
		assert.equal(conn.why, "This session is no longer live in a pane.");
		assert.equal(conn.ended, true);
		assert.deepEqual(ends, [], "not live is a refusal, not a gone pane");
		reply = { ok: false, status: 404, body: {} };
		conns.retry(conn);
		await settle();
		assert.match(conn.why, /404/);
		assert.deepEqual(ends, ["end"], "404 ends");
		reply = { ok: false, status: 409, body: { error: "pane_closed", reason: "closed" } };
		conns.retry(conn);
		await settle();
		assert.deepEqual(ends, ["end", "end"], "pane_closed ends");
		reply = fine;
		conns.retry(conn);
		assert.equal(conn.phase, "connecting");
		await settle();
		assert.deepEqual(w.mirrorPosts(), ["mirror:K:true", "mirror:K:true", "mirror:K:true", "mirror:K:true"]);
		conns.retry(conn);
		await settle();
		assert.equal(w.posts.length, 4, "a live connection is not retried");
		conns.frame(frame({ ended: "The pane could not be read." }));
		assert.equal(conn.phase, "refused");
		assert.match(conn.why, /could not be read/);
		assert.deepEqual(ends, ["end", "end", "end"], "an ended frame ends too");
	} finally {
		stop();
	}
});

test("a network failure refuses without ending the watchers", async () => {
	const conns = mountConns({ post: () => async () => { throw new Error("offline"); }, stream: () => JSON.stringify({ stream: "s1" }) });
	const ends: string[] = [];
	const { conn, stop } = conns.join("K", { end: () => void ends.push("end") });
	try {
		await settle();
		assert.equal(conn.phase, "refused");
		assert.deepEqual(ends, []);
	} finally {
		stop();
	}
});

test("one key is one attach: the first to join attaches, the last to leave detaches, a hello attaches the connection once", async () => {
	const w = world(), conns = mountConns(w);
	const one = conns.join("K", {}), two = conns.join("K", {});
	await settle();
	assert.equal(one.conn, two.conn);
	assert.deepEqual(w.mirrorPosts(), ["mirror:K:true"]);
	const other = conns.join("L", {});
	await settle();
	assert.deepEqual(w.mirrorPosts(), ["mirror:K:true", "mirror:L:true"], "another key has its own");
	w.newStream("s2");
	conns.hello();
	await settle();
	assert.deepEqual(w.posts.slice(2).map(([a, b]) => `${a}:${b.stream}:${b.on}`), ["mirror:K:s2:true", "mirror:L:s2:true"], "one attach per key to the new stream");
	one.stop();
	one.stop();
	await settle();
	assert.equal(w.posts.length, 4, "one still holds it; leaving twice is one leave");
	two.stop();
	await settle();
	assert.deepEqual(w.posts.at(-1), ["mirror:K", { stream: "s2", on: false }]);
	w.newStream("s3");
	conns.hello();
	await settle();
	assert.deepEqual(w.posts.slice(5).map(([a]) => a), ["mirror:L"], "a left key is not attached again");
	other.stop();
	const again = conns.join("K", {});
	await settle();
	assert.equal(w.mirrorPosts().at(-1), "mirror:K:true", "joining a key nobody holds attaches it anew");
	assert.notEqual(again.conn, one.conn);
	again.stop();
	await settle();
});

test("the tab hidden for 5 s parks every connection once (a watcher count does not matter) and showing it attaches again", async () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const w = world(), conns = mountConns(w);
		const a = conns.join("K", {}), b = conns.join("K", {});
		await settle();
		doc.hidden = true;
		listeners.forEach((f) => f());
		mock.timers.tick(5000);
		await settle();
		assert.deepEqual(w.mirrorPosts(), ["mirror:K:true", "mirror:K:false"]);
		assert.equal(a.conn.parked, true);
		assert.equal(a.conn.phase, "paused");
		assert.equal(a.conn.state(), "off");
		doc.hidden = false;
		listeners.forEach((f) => f());
		await settle();
		assert.deepEqual(w.mirrorPosts(), ["mirror:K:true", "mirror:K:false", "mirror:K:true"]);
		a.stop();
		b.stop();
	} finally {
		mock.timers.reset();
		doc.hidden = false;
	}
});

test("a watcher and an embedded terminal on one key share one attach and one set of rows; the embed starts with the rows the watcher holds and leaving it keeps the mirror for the watcher", async () => {
	const w = world();
	const padCalls: { entered(sent: boolean): void; taken(): void }[] = [];
	const terminals = mountTerminals({ tiles: { open() {} }, post: w.post, stream: w.stream, pad: (x) => (padCalls.push(x), { el: new El() as never, update() {} }) });
	const got: string[][] = [], states: string[] = [], ends: string[] = [], taken: string[] = [];
	const watching = terminals.watch("K", "billing", { rows: (rows) => void got.push([...rows]), state: (s) => void states.push(s), end: () => void ends.push("end"), taken: () => void taken.push("taken") });
	await settle();
	terminals.frame(frame({ rows: 2, cols: 20, whole: true, set: [[0, "ROW-ONE"], [1, "ROW-TWO"]] }));
	assert.deepEqual(got, [["ROW-ONE", "ROW-TWO"]]);
	const host = new El(), embedEnds: string[] = [];
	const off = terminals.embed("K", "billing", host as never, { end: () => void embedEnds.push("end") });
	await settle();
	assert.deepEqual(w.mirrorPosts(), ["mirror:K:true"], "embedding a key the watcher holds attaches nothing");
	assert.match(host.textContent, /ROW-ONE/);
	assert.match(host.textContent, /ROW-TWO/, "the embed draws the rows the connection already holds");
	terminals.frame(frame({ rows: 2, cols: 20, set: [[1, "NEXT"]] }));
	assert.match(host.textContent, /NEXT/);
	assert.deepEqual(got.at(-1), ["ROW-ONE", "NEXT"], "both hear a frame");
	padCalls[0]!.entered(false);
	padCalls[0]!.entered(true);
	assert.deepEqual(taken, [], "an Enter going, or refused, is not taken");
	padCalls[0]!.taken();
	assert.deepEqual(taken, ["taken"], "the watcher hears the Enter the server took from the embed's pad");
	terminals.frame(frame({ ended: "pane closed" }));
	assert.deepEqual([ends, embedEnds], [["end"], ["end"]], "both hear the end");
	off();
	await settle();
	assert.deepEqual(w.mirrorPosts(), ["mirror:K:true"], "the embed leaving detaches nothing while the watcher holds the key");
	watching.stop();
	await settle();
	assert.deepEqual(w.mirrorPosts(), ["mirror:K:true", "mirror:K:false"], "the last to leave detaches");
	assert.ok(states.length > 0);
});

test("a tile opened on a key a watcher holds shows its rows and its phase, and closing the tile leaves the watcher's mirror", async () => {
	const w = world();
	const opened: { body(): El; closed?(): void }[] = [];
	const terminals = mountTerminals({ tiles: { open: (tile) => void opened.push(tile as never) }, post: w.post, stream: w.stream });
	const watching = terminals.watch("K", "billing", {});
	await settle();
	terminals.frame(frame({ rows: 1, cols: 20, whole: true, set: [[0, "HELD-ROW"]] }));
	terminals.open("K", "billing");
	await settle();
	const tile = opened[0]!.body();
	assert.match(tile.textContent, /HELD-ROW/);
	assert.deepEqual(w.mirrorPosts(), ["mirror:K:true"]);
	opened[0]!.closed!();
	await settle();
	assert.deepEqual(w.mirrorPosts(), ["mirror:K:true"], "the watcher still holds it");
	watching.stop();
	await settle();
	assert.deepEqual(w.mirrorPosts(), ["mirror:K:true", "mirror:K:false"]);
});
