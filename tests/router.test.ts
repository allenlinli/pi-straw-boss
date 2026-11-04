import assert from "node:assert/strict";
import { test } from "node:test";
import { depthOf, formatRoute, netOf, parseRoute, type Route, SECTIONS, upOf, watchOf } from "../gui/router.ts";

test("routes parse below the base and format back, for the map, a workspace, and a session", () => {
	assert.deepEqual(parseRoute(""), { view: "map" });
	assert.deepEqual(parseRoute("w/wA"), { view: "workspace", ws: "wA" });
	assert.deepEqual(parseRoute("w/wA/s/abc"), { view: "session", ws: "wA", key: "abc" });
	assert.deepEqual(parseRoute("/w/wA/s/abc/"), { view: "session", ws: "wA", key: "abc" }, "slashes at either end do not matter");
	assert.deepEqual(parseRoute("w/wA/s/abc?x=1#top"), { view: "session", ws: "wA", key: "abc" });
	for (const route of [{ view: "map" }, { view: "workspace", ws: "wA" }, { view: "session", ws: "wA", key: "abc" }] as Route[]) assert.deepEqual(parseRoute(formatRoute(route)), route);
});

test("ids with slashes, spaces, percent signs, and non-ASCII letters survive a round trip", () => {
	for (const id of ["a/b", "a b", "100%", "w:1", "成型機 #3", "c-1/lint sweep", "..", ".", "../etc", "q?x=1#y"]) {
		const route: Route = { view: "session", ws: id, key: id };
		const path = formatRoute(route);
		assert.ok(!/[?#]/.test(path) && path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."), `${id} is encoded in ${path}`);
		assert.deepEqual(parseRoute(path), route, id);
	}
	assert.equal(formatRoute({ view: "session", ws: "a/b", key: "c d" }), "w/a%2Fb/s/c%20d");
});

test("a session route keeps the entry it opens at, and going up or watching ignores it", () => {
	const at: Route = { view: "session", ws: "wA", key: "k/1", at: "e 9/x" };
	assert.equal(formatRoute(at), "w/wA/s/k%2F1?at=e%209%2Fx");
	assert.deepEqual(parseRoute(formatRoute(at)), at);
	assert.deepEqual(parseRoute("w/wA/s/k?at="), { view: "session", ws: "wA", key: "k" }, "an empty anchor is no anchor");
	assert.deepEqual(parseRoute("w/wA?at=e1"), { view: "workspace", ws: "wA" }, "only a session has an anchor");
	assert.deepEqual([upOf(at), watchOf(at)], [{ view: "workspace", ws: "wA" }, "k/1"]);
});

test("anything that is not a route is the map, and a bad escape does not throw", () => {
	for (const rel of ["w", "w/", "x/y", "w//s/k", "assets/app.js", "events"]) assert.deepEqual(parseRoute(rel), { view: "map" }, rel);
	assert.deepEqual(parseRoute("w/%E0%A4%A"), { view: "workspace", ws: "%E0%A4%A" });
	assert.deepEqual(parseRoute("w/wA/s"), { view: "workspace", ws: "wA" }, "a session route needs its key");
});

test("one level up goes from a session to its workspace to the map, and each route says what the stream should watch", () => {
	const session: Route = { view: "session", ws: "wA", key: "k" };
	assert.deepEqual(upOf(session), { view: "workspace", ws: "wA" });
	assert.deepEqual(upOf(upOf(session)), { view: "map" });
	assert.deepEqual(upOf({ view: "map" }), { view: "map" });
	assert.deepEqual([watchOf({ view: "map" }), watchOf({ view: "workspace", ws: "wA" }), watchOf(session)], [null, "w:wA", "k"]);
});

test("a history entry counts the page's own entries behind it, and an entry the page did not push counts none", () => {
	assert.equal(depthOf({ depth: 2 }), 2);
	for (const state of [null, undefined, {}, { depth: 0 }, { depth: -1 }, "x"]) assert.equal(depthOf(state), 0, JSON.stringify(state));
});

test("the settings page is a route of its own, with a section to open at, and anything else under it is the page", () => {
	assert.deepEqual(parseRoute("settings"), { view: "settings" });
	assert.deepEqual(parseRoute("/settings/"), { view: "settings" }, "slashes at either end do not matter");
	assert.deepEqual(parseRoute("settings?x=1#top"), { view: "settings" });
	for (const section of SECTIONS) assert.deepEqual(parseRoute(`settings/${section}`), { view: "settings", section });
	assert.deepEqual(parseRoute("settings/nonsense"), { view: "settings" }, "a section the page lacks opens the page");
	assert.deepEqual(parseRoute("settings/wifi/more"), { view: "settings", section: "wifi" });
	for (const route of [{ view: "settings" }, { view: "settings", section: "teams" }, { view: "settings", section: "wifi" }] as Route[]) assert.deepEqual(parseRoute(formatRoute(route)), route);
	assert.equal(formatRoute({ view: "settings" }), "settings");
	assert.equal(formatRoute({ view: "settings", section: "phone" }), "settings/phone");
	assert.deepEqual(parseRoute("w/settings"), { view: "workspace", ws: "settings" }, "a workspace named settings is still a workspace");
});

test("the settings page watches the net only, goes up to the map, and shows the focus views the map", () => {
	const page: Route = { view: "settings", section: "phone" };
	assert.equal(watchOf(page), null);
	assert.deepEqual(upOf(page), { view: "map" });
	assert.deepEqual(netOf(page), { view: "map" });
	const session: Route = { view: "session", ws: "wA", key: "k" };
	assert.equal(netOf(session), session, "a route of the net is passed on as it is");
});

test("the head page is the route `head`: it formats back, a session link to the head's stand-in workspace is the same address, going up leaves for the map, and the stream watches the key the net gives", () => {
	assert.deepEqual(parseRoute("head"), { view: "head" });
	assert.deepEqual(parseRoute("/head/"), { view: "head" });
	assert.deepEqual(parseRoute("head?x=1"), { view: "head" });
	assert.equal(formatRoute({ view: "head" }), "head");
	assert.equal(formatRoute({ view: "session", ws: "@head", key: "sb-head" }), "head", "any link to the head's key opens the head page");
	assert.deepEqual(parseRoute(formatRoute({ view: "head" })), { view: "head" });
	assert.deepEqual(upOf({ view: "head" }), { view: "map" });
	assert.deepEqual(upOf({ view: "session", ws: "@head", key: "sb-head" }), { view: "map" });
	assert.equal(watchOf({ view: "head" }), null, "the key is the net's: nothing to watch before the first snapshot");
	assert.equal(watchOf({ view: "head" }, "sb-head-ab12cd34"), "sb-head-ab12cd34");
	assert.deepEqual(netOf({ view: "head" }), { view: "head" }, "the focus views draw it");
	assert.deepEqual(parseRoute("headx"), { view: "map" });
	assert.deepEqual(parseRoute("head/extra"), { view: "map" }, "the head page has no sub route");
});
