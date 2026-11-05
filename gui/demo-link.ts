import type { Net, TowerService } from "../src/net.ts";

// The demo's stand-in for the routes behind Zen's link cards (`?zen=link-confirm|link-dialog|pair|proposal`): a confirm a teammate's tower asked, a dialog an unattended device forwarded, a pair request, and a memory proposal. It answers as the server does:
// a request is taken and gone from the next snapshot, a number other than 4821 is `no_match`, and `&refuse` makes every answer a refusal with the server's own words.

export const LINK_STATES = ["link-confirm", "link-dialog", "pair", "proposal"] as const;
export type LinkState = (typeof LINK_STATES)[number];
export const isLinkState = (s: string | null): s is LinkState => LINK_STATES.includes(s as LinkState);

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const DIGEST = "c".repeat(64);
export const PAIR_NUMBER = "4821";

export interface LinkDemoIo { net(): Net; /** Applies `mut` to the net and sends the new snapshot. */ change(mut: (n: Net) => void): void; service(): TowerService }
export function linkDemo(state: LinkState, io: LinkDemoIo, refuse: boolean, now = Date.now()): void {
	let pairs = state === "pair" ? [{ id: "ab12cd34ef56", label: "Mei's iPhone", peer: "192.168.1.23", iface: "en0", since: now - 20_000 }] : [];
	io.change((n) => {
		const link = (n.link ??= { allies: [], alerts: [], confirms: [], units: [] });
		if (state === "link-confirm") link.confirms = [{ dialogId: "dc1", team: "t", from: "d2", fromLabel: "Mei's Mac", fromShort: "b1c2d3", digest: DIGEST, tool: "bash", args: "npm run deploy -- --env staging --force", tower: "Harbor API tower", at: now - 90_000 }];
		if (state === "link-dialog") link.alerts.push({ id: "dialog/d2/DD1", kind: "dialog", level: "warning", team: "t", teamName: "moldplan", data: { device: "d2", dialogId: "DD1", digest: DIGEST, owner: "rpiv", dialog: JSON.stringify({ select: { title: "Run the migration on staging now?", choices: [{ label: "Run it now" }, { label: "Wait for the review" }, { label: "Skip this release" }] } }), label: "Mei's Mac", short: "b1c2d3" } });
		if (state === "proposal") n.bases[0]!.tower!.service = { ...io.service(), memory: { rev: 7, standing: 0, decisions: 0, waits: 0, bossWaits: [], proposals: [{ id: "P1", op: "add", kind: "standing", text: "Never deploy to production on Fridays", cites: "Hold off on prod deploys until Monday" }] } };
	});
	const real = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url, at = /api\/(link\/confirm-answer|link\/dialog-answer|lan\/approve|lan\/pending|tower\/\w+\/memory)/.exec(url)?.[1];
		if (!at) return real(input, init);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		if (at === "lan/pending") return reply(200, { pending: pairs.map((p) => ({ ...p, age: "20 s", ageMs: Date.now() - p.since })) });
		if (at === "link/confirm-answer") return refuse ? reply(409, { error: "link_failed", reason: "That request is gone or has timed out" }) : (io.change((n) => void (n.link!.confirms = [])), reply(200, {}));
		if (at === "link/dialog-answer") return refuse ? reply(409, { error: "link_failed", reason: "That dialog is already closed" }) : (io.change((n) => void n.link!.alerts.forEach((a) => a.kind === "dialog" && Object.assign(a.data, { answered: 1, closed: "remote" }))), reply(200, {}));
		if (at === "lan/approve") {
			if (typeof body.deny === "string") return ((pairs = []), reply(200, { denied: 1 }));
			if (refuse || body.number !== PAIR_NUMBER) return reply(404, { error: "no_match", reason: "No request has that number." });
			return ((pairs = []), reply(200, { paired: { id: "ab12cd34ef56", label: "Mei's iPhone", peer: "192.168.1.23" } }));
		}
		if (refuse) return reply(409, { error: "rev", reason: "The memory changed since you read it; it is shown again.", rev: 8, entries: [], proposals: [] });
		io.change((n) => void (n.bases[0]!.tower!.service!.memory!.proposals = []));
		return reply(200, { rev: 8, proposals: [], entries: [] });
	};
}
