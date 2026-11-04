// A process tree that does not die of SIGTERM, for tests/procs-kill.test.ts. Every process arms an unref'd process.exit(3) timer, so one that leaks past its test ends itself.
//   node procs-stubborn.mjs leaf           ignores SIGTERM and idles
//   node procs-stubborn.mjs middle         starts a detached leaf, prints its pid, exits (the leaf is then an orphan)
//   node procs-stubborn.mjs root           ignores SIGTERM; starts a leaf in its own group, a leaf in a new session of its own, and a middle; prints {"a","b","m","c"} and idles
import { spawn } from "node:child_process";

const [, , mode] = process.argv;
const self = new URL(import.meta.url).pathname;
process.on("SIGTERM", () => {});
setTimeout(() => process.exit(3), 120_000).unref();
const child = (kind, detached, stdio = "ignore") => spawn(process.execPath, [self, kind], { detached, stdio, cwd: process.cwd() });
const idle = () => setInterval(() => {}, 1000);

if (mode === "leaf") idle();
else if (mode === "middle") {
	const c = child("leaf", true);
	c.unref();
	process.stdout.write(`${c.pid}\n`, () => process.exit(0));
} else if (mode === "root") {
	const a = child("leaf", false), b = child("leaf", true), m = child("middle", true, ["ignore", "pipe", "ignore"]);
	b.unref();
	let text = "";
	m.stdout.on("data", (d) => (text += d));
	m.on("exit", () => {
		process.stdout.write(`${JSON.stringify({ a: a.pid, b: b.pid, m: m.pid, c: Number(text.trim()) })}\n`);
	});
	idle();
}
