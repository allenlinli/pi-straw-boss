import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { canonical, openReader, readers } from "../src/history.ts";
import { idOf, openLedger, type Seen, transcriptKey } from "../src/server/operateledger.ts";
import { operateOff } from "../src/server/operateoff.ts";
import { type Hub, watchSession } from "../src/watch.ts";
import { DEVICES } from "./link/scenario.ts";
import { assistant, header, lines, text, user } from "./sessions.ts";

// Second re-review of the operate wiring (todo #121, RR-F001 and RR-F003): a watch of a finished run's transcript key shows the transcript, and a switch file that is a dangling symlink reads as off.

const scratch = canonical(mkdtempSync(join(tmpdir(), "psb-operate-rr5-")))!, root = join(scratch, "sessions");
mkdirSync(root);
after(() => rmSync(scratch, { recursive: true, force: true }));
const A = "a".repeat(32), NOW = Date.UTC(2026, 10, 7, 12);

test("RR-F001: a watch of a t<id> transcript key gets the transcript's history, not an unknown key", async () => {
	const file = join(root, "2026-11-07T00-00-00-000Z_w1.jsonl");
	writeFileSync(file, lines([header("w1"), user("u1", null, "hi"), assistant("a1", "u1", [text("done hi")])]));
	const ledger = openLedger({ file: join(scratch, "l1", "link", "operate-ledger.jsonl"), root, now: () => NOW });
	const seen: Seen = { role: "ally", name: "ally run", workspace: "billing", file, owner: { team: A }, device: DEVICES.alice.id };
	ledger.observe([seen]);
	ledger.observe([]); // the run ended
	const hub: Hub = { lookup: () => undefined, workspace: () => [], readers: readers(8, (f) => openReader(f)), transcripts: ledger.within(() => ({ teams: [A], box: false })) };
	const sent: { event: string; data: { state?: string; items?: unknown[] } }[] = [];
	const w = watchSession(hub, transcriptKey(idOf(file)), (event, data) => sent.push({ event, data: data as never }));
	await w.refresh();
	w.stop();
	assert.deepEqual(sent.map((s) => [s.data.state, s.data.items?.length]), [["recent", 2]]);
});

test("RR-F003: anything at the switch file's path reads as off, a dangling symlink too; a symlink to a valid file and a directory as before; nothing there is on", () => {
	const dir = mkdtempSync(join(scratch, "s-")), file = join(dir, "operate-off.json");
	assert.equal(operateOff(file, () => 5).since(), undefined, "nothing there: on");
	symlinkSync(join(dir, "nowhere.json"), file);
	assert.equal(operateOff(file, () => 5).since(), 5, "a dangling symlink");
	const dir2 = mkdtempSync(join(scratch, "s2-")), target = join(dir2, "t.json"), link = join(dir2, "operate-off.json");
	writeFileSync(target, JSON.stringify({ since: 7 }));
	symlinkSync(target, link);
	assert.equal(operateOff(link, () => 5).since(), 7, "a symlink to a valid file");
	const dir3 = join(mkdtempSync(join(scratch, "s3-")), "operate-off.json");
	mkdirSync(dir3);
	assert.equal(operateOff(dir3, () => 5).since(), 5, "a directory");
});
