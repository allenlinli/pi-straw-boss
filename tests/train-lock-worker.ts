import { appendFileSync, existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../src/server/trainlock.ts";

// A process of tests/train-gate.test.ts's lock tests (not a test itself): argv[2] is a JSON object. Everything is synchronous, so two of these overlap only through the files they share.
//   mode "rounds": per round r, spin until `go-r` exists, try to take the lock once and write `res-r-id` ({ ok, why }); a winner holds it until `rel-r` exists and releases; `fin-r-id` ends the round.
//   mode "stall": take the lock once and, while holding the marker (after the re-read, before the replace), write `in-marker` and wait for `go`; then write `res-stall` ({ ok }) and, a winner, hold the lock until `rel`.
//   mode "contend": N times, take the lock (trying again until it is free), enter a critical region that a second process in it would see, and leave.

const arg = JSON.parse(process.argv[2]!) as { mode: "rounds" | "contend" | "stall"; dir: string; name: string; id: number; sync: string; rounds?: number; times?: number };
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const spinUntil = (file: string) => {
	for (const end = Date.now() + 60_000; !existsSync(file); pause(1)) if (Date.now() > end) throw new Error(`worker ${arg.id}: ${file} never came`);
};
const who = { train: "2026-11-07-a", step: arg.id };

if (arg.mode === "stall") {
	const taken = takeLock(arg.dir, arg.name, { ...who }, { beforeReplace: () => (writeFileSync(join(arg.sync, "in-marker"), ""), spinUntil(join(arg.sync, "go"))) });
	writeFileSync(join(arg.sync, "tmp-stall"), JSON.stringify({ ok: taken.ok }));
	renameSync(join(arg.sync, "tmp-stall"), join(arg.sync, "res-stall"));
	if (taken.ok) {
		spinUntil(join(arg.sync, "rel"));
		taken.release();
	}
} else if (arg.mode === "rounds") {
	for (let r = 1; r <= arg.rounds!; r++) {
		spinUntil(join(arg.sync, `go-${r}`));
		const taken = takeLock(arg.dir, arg.name, { ...who });
		// Written whole under another name and renamed, so the test never reads half of it.
		writeFileSync(join(arg.sync, `tmp-${r}-${arg.id}`), JSON.stringify({ ok: taken.ok, ...(taken.ok ? {} : { why: taken.why, holder: taken.holder?.step }) }));
		renameSync(join(arg.sync, `tmp-${r}-${arg.id}`), join(arg.sync, `res-${r}-${arg.id}`));
		if (taken.ok) {
			spinUntil(join(arg.sync, `rel-${r}`));
			taken.release();
		}
		writeFileSync(join(arg.sync, `fin-${r}-${arg.id}`), "");
	}
} else {
	const inside = join(arg.sync, "inside");
	for (let i = 0; i < arg.times!; i++) {
		let taken = takeLock(arg.dir, arg.name, { ...who });
		while (!taken.ok) {
			pause(1);
			taken = takeLock(arg.dir, arg.name, { ...who });
		}
		try {
			writeFileSync(inside, String(process.pid), { flag: "wx" });
		} catch {
			appendFileSync(join(arg.sync, "violations"), `${process.pid}\n`);
		}
		appendFileSync(join(arg.sync, "entries"), `${process.pid}\n`);
		pause(1);
		try { unlinkSync(inside); } catch { /* a violator removed it */ }
		taken.release();
	}
}
