import { randomBytes, type KeyObject } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { equalBytes, operateEphemeral, operateKeys, operateOpen, operateSeal, sha256, TEAM_ID_BYTES } from "./crypto.ts";
import { idOk } from "./device.ts";
import { operateBody, type OperateMessage } from "./kinds.ts";

// The session core of Straw Link operate (docs/specs/2026-11-07-link-operate.md §5.2, §5.3, §5.6): the handshake, the two keys, the frame counters,
// deflate and parts, pings, the 45 s silence and the 12 h rekey. A pure module: it reads a clock and writes to a transport it is given, owns no
// timer (the host calls `tick()` about once a second) and no socket, and holds nothing about policy, scope or what an inner message means.
//
// The send counter belongs to the session. `operateSeal` is stateless, so a repeated (key, direction, ctr) would reuse a ChaCha20-Poly1305 nonce;
// nothing outside this file seals a frame. A session never resumes a counter across a reopen (every open makes a fresh ephemeral key and a fresh
// session id) and drops its keys when it ends.

export const OPERATE_LIMITS = {
	/** A ping goes out when nothing was sent for this long; no frame from the peer for `silenceMs` ends the session on either side. */
	pingMs: 15_000,
	silenceMs: 45_000,
	/** A part missing this long after the last part of its message drops the message. */
	partMs: 10_000,
	/** A session lasts at most 12 hours; the controller then opens a new one. */
	rekeyMs: 12 * 3600_000,
	/** The controller gives up on an open that nobody answered (the page's own request limit is 20 s too, §5.5). */
	openWaitMs: 20_000,
	/** A deflated message over `frameBytes` goes in parts of at most `partBytes`, so a part's frame (base64 in JSON, deflated again) stays under it. */
	frameBytes: 160 * 1024,
	partBytes: 120 * 1024,
	/** Caps on one message (deflated, and inflated), on all the reassembly in flight in a session, on messages in flight, and on the parts one message names. */
	messageBytes: 4 * 1024 * 1024,
	pendingBytes: 8 * 1024 * 1024,
	pendingMessages: 16,
	maxParts: 64,
	/** The longest `t` of an inner message. */
	typeChars: 16,
	/** How long the box remembers a session id it admitted, which covers the holder's 60 s freshness window with room for skew. */
	seenMs: 120_000,
	/** The host's tick interval. */
	tickMs: 1000,
	/** At most this many sessions per operator device per team and per box (§5.2). */
	perOperator: 2,
	perBox: 6,
} as const;

/** The inner message: `t` says what it is, the rest is the host's. The core reads `ping` and `part` and passes every other to `onInner`, unchecked beyond its `t`. */
export interface OperateInner { t: string; [field: string]: unknown }

/**
 * Why a session ended. `reason` is ours: `refused`, `no-answer`, `bad-key`, `silence`, `rekey`, `peer-closed`, or the word the host gave `close()`. `peer` is the other end's own word
 * (a `refuse` or a `close`) and is untrusted text, short but the peer's.
 */
export interface OperateEnd { reason: string; peer?: string }
export type DropReason = "from" | "session" | "role" | "state" | "hash" | "replay" | "unsealed" | "inflate" | "malformed" | "part-invalid" | "part-mismatch" | "part-duplicate" | "part-limit" | "part-nested" | "part-timeout";
/** A message the session took off the wire and did not use. Names only: nothing of the content. */
export interface OperateDrop { reason: DropReason; type?: string }

export interface OperateDeps {
	now: () => number;
	/** One outer message to the peer, in order. A throw or a rejection goes to `onTransportError` and does not end the session: a lost frame is lost, and the silence timer decides. */
	send: (message: OperateMessage) => void | Promise<void>;
	onTransportError: (error: unknown) => void;
	/** The operator's session is open: the box's `scope` and `limits`, as it wrote them (the host clamps them: the wire holds unbounded integers). */
	onOpen?: (accepted: { scope: { teams: Buffer[]; box: boolean }; limits: { mirrors: number; watches: number; budget: number } }) => void;
	onInner: (inner: OperateInner) => void;
	onEnd: (end: OperateEnd) => void;
	onDrop?: (drop: OperateDrop) => void;
	/** For the test vectors: the ephemeral key and the session id. Without them every open is random. */
	ephemeral?: () => { key: KeyObject; pub: Buffer };
	sessionId?: () => Buffer;
}

type Opening = Extract<OperateMessage, { type: "open" }>;
type Accepting = Extract<OperateMessage, { type: "accept" }>;
type Framed = Extract<OperateMessage, { type: "frame" }>;
export type OperateRole = "operator" | "box";
export type OperateState = "opening" | "open" | "closed";

interface Assembling { n: number; parts: Map<number, Buffer>; bytes: number; last: number }

const innerOk = (v: unknown): v is OperateInner => typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { t?: unknown }).t === "string" && (v as { t: string }).t.length > 0 && (v as { t: string }).t.length <= OPERATE_LIMITS.typeChars;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

/** The two keys in one buffer (operator → box, then box → operator), so one `fill(0)` at the end drops both; the derivation's own copies are zeroed here. */
function join(k: { toBox: Buffer; toOperator: Buffer }): Buffer {
	const both = Buffer.concat([k.toBox, k.toOperator]);
	k.toBox.fill(0);
	k.toOperator.fill(0);
	return both;
}

export class OperateSession {
	readonly role: OperateRole;
	readonly team: Buffer;
	readonly id: Buffer;
	readonly self: string;
	readonly peer: string;
	private readonly deps: OperateDeps;
	private status: OperateState;
	private startedAt: number;
	private lastSent: number;
	private lastRecv: number;
	private sentCtr = 0;
	private recvCtr = 0;
	private partId = 0;
	/** The operator's ephemeral key until the accept comes; both ends' derived keys until the end. */
	private mine: KeyObject | undefined;
	private keys: Buffer | undefined;
	private opening: Opening | undefined;
	private pending = new Map<number, Assembling>();
	private pendingBytes = 0;

	private constructor(role: OperateRole, deps: OperateDeps, o: { team: Buffer; id: Buffer; self: string; peer: string }, status: OperateState) {
		this.role = role;
		this.deps = deps;
		this.team = o.team;
		this.id = o.id;
		this.self = o.self;
		this.peer = o.peer;
		this.status = status;
		this.startedAt = this.lastSent = this.lastRecv = deps.now();
	}

	get state(): OperateState {
		return this.status;
	}

	/** The controller's side: a fresh ephemeral key and session id, an `open` to the box. Throws for a team or a device id that cannot be a session's. */
	static open(deps: OperateDeps, o: { team: Buffer; self: string; peer: string; want: "team" | "box" }): OperateSession {
		if (o.team.length !== TEAM_ID_BYTES) throw new RangeError("an operate session names a 16-byte team id");
		if (!idOk(o.self) || !idOk(o.peer)) throw new RangeError("an operate session names two device ids");
		const eph = (deps.ephemeral ?? operateEphemeral)(), id = (deps.sessionId ?? (() => randomBytes(16)))();
		const s = new OperateSession("operator", deps, { team: o.team, id, self: o.self, peer: o.peer }, "opening");
		s.mine = eph.key;
		s.opening = { session: id, type: "open", eph: eph.pub, caps: ["operate/1"], want: o.want };
		s.emit(s.opening);
		return s;
	}

	/**
	 * The box's side: takes an `open` the host has admitted (a team's admin, a session id not seen, under the limits: `OperateRegistry`) and answers it. A fresh ephemeral key; an `accept`
	 * with the hash of the open body, so the box's signature covers the operator's key. An ephemeral key that is a low-order point makes no session: the box sends `refuse` and this
	 * returns undefined. `from` is the open's signer, the operator's device id.
	 */
	static accept(deps: OperateDeps, o: { team: Buffer; self: string; from: string; open: Opening; scope: Accepting["scope"]; limits: Accepting["limits"] }): OperateSession | undefined {
		const eph = (deps.ephemeral ?? operateEphemeral)();
		let keys: { toBox: Buffer; toOperator: Buffer };
		try {
			keys = operateKeys({ team: o.team, session: o.open.session, operator: o.from, box: o.self, ephOp: o.open.eph, ephBox: eph.pub, mine: eph.key, theirs: o.open.eph });
		} catch {
			refuseOpen(deps, o.open.session, "bad-key");
			return undefined;
		}
		const s = new OperateSession("box", deps, { team: o.team, id: o.open.session, self: o.self, peer: o.from }, "open");
		s.keys = join(keys);
		s.emit({ session: o.open.session, type: "accept", eph: eph.pub, openHash: sha256(operateBody(o.open)), scope: o.scope, limits: o.limits });
		return s;
	}

	/** An outer message the holder took, from the device `from` (the envelope's signer). Drops what is not this session's, not from its peer, or not for this end. */
	receive(message: OperateMessage, from: string): void {
		if (this.status === "closed") return;
		if (from !== this.peer) return this.drop("from", message.type);
		if (!message.session.equals(this.id)) return this.drop("session", message.type);
		switch (message.type) {
			case "accept": return this.role === "operator" ? this.onAccept(message) : this.drop("role", "accept");
			case "refuse":
				if (this.role !== "operator") return this.drop("role", "refuse");
				if (this.status !== "opening") return this.drop("state", "refuse");
				return this.finish({ reason: "refused", peer: message.reason });
			case "frame": return this.status === "open" ? this.onFrame(message) : this.drop("state", "frame");
			case "close": return this.finish({ reason: "peer-closed", peer: message.reason });
			case "open": return this.drop("role", "open");
		}
	}

	/** Seals one inner message and sends it, in parts over 160 KB deflated. False when the session is not open. Throws for a message over 4 MB or one that is not an inner message. */
	send(inner: OperateInner): boolean {
		if (!innerOk(inner) || inner.t === "part") throw new RangeError("an inner message has a short type of its own, and part is the core's");
		if (this.status !== "open") return false;
		const json = Buffer.from(JSON.stringify(inner));
		if (json.length > OPERATE_LIMITS.messageBytes) throw new RangeError("an operate message is at most 4 MB");
		const z = deflateRawSync(json);
		if (z.length <= OPERATE_LIMITS.frameBytes) return (this.frame(z), true);
		if (z.length > OPERATE_LIMITS.messageBytes) throw new RangeError("an operate message is at most 4 MB");
		const of = ++this.partId, n = Math.ceil(z.length / OPERATE_LIMITS.partBytes);
		for (let i = 0; i < n; i++) this.frame(deflateRawSync(Buffer.from(JSON.stringify({ t: "part", of, i, n, bytes: z.subarray(i * OPERATE_LIMITS.partBytes, (i + 1) * OPERATE_LIMITS.partBytes).toString("base64") }))));
		return true;
	}

	/** Ends the session: a `close` with the word, the keys dropped. Does nothing to one that has ended. */
	close(reason: string): void {
		if (this.status === "closed") return;
		this.emit({ session: this.id, type: "close", reason });
		this.finish({ reason });
	}

	/** The clock's work, for the host to call about once a second: the open's answer, the 12 h rekey, the 45 s silence, parts that stopped coming, a ping when nothing was sent for 15 s. */
	tick(): void {
		if (this.status === "closed") return;
		const now = this.deps.now();
		if (this.status === "opening") return now - this.startedAt >= OPERATE_LIMITS.openWaitMs ? this.endWith("no-answer") : undefined;
		if (now - this.startedAt >= OPERATE_LIMITS.rekeyMs) return this.endWith("rekey");
		if (now - this.lastRecv >= OPERATE_LIMITS.silenceMs) return this.endWith("silence");
		for (const [of, a] of [...this.pending]) {
			if (now - a.last < OPERATE_LIMITS.partMs) continue;
			this.discard(of);
			this.drop("part-timeout", "part");
		}
		if (now - this.lastSent >= OPERATE_LIMITS.pingMs) this.frame(deflateRawSync(Buffer.from('{"t":"ping"}')));
	}

	private endWith(reason: string): void {
		this.emit({ session: this.id, type: "close", reason });
		this.finish({ reason });
	}

	private onAccept(m: Accepting): void {
		if (this.status !== "opening" || !this.mine || !this.opening) return this.drop("state", "accept");
		if (!equalBytes(m.openHash, sha256(operateBody(this.opening)))) return this.drop("hash", "accept");
		try {
			this.keys = join(operateKeys({ team: this.team, session: this.id, operator: this.self, box: this.peer, ephOp: this.opening.eph, ephBox: m.eph, mine: this.mine, theirs: m.eph }));
		} catch {
			return this.endWith("bad-key");
		}
		this.mine = this.opening = undefined;
		this.status = "open";
		this.startedAt = this.lastRecv = this.lastSent = this.deps.now();
		this.deps.onOpen?.({ scope: m.scope, limits: m.limits });
	}

	private onFrame(m: Framed): void {
		if (m.ctr <= this.recvCtr) return this.drop("replay", "frame");
		const keys = this.keys!, mine = this.role === "box";
		const plain = operateOpen({ key: mine ? keys.subarray(0, 32) : keys.subarray(32), dir: mine ? "toBox" : "toOperator", session: this.id, ctr: m.ctr, ct: m.ct });
		if (!plain) return this.drop("unsealed", "frame");
		// Only a frame that opens moves the counter and counts as a sign of life: a team member's junk costs the real peer nothing.
		this.recvCtr = m.ctr;
		this.lastRecv = this.deps.now();
		this.take(plain, false);
	}

	/** An inflated, parsed inner message, from a frame (`plain` is its deflated bytes) or from reassembled parts. */
	private take(z: Buffer, assembled: boolean): void {
		let inner: unknown;
		try {
			inner = JSON.parse(inflateRawSync(z, { maxOutputLength: OPERATE_LIMITS.messageBytes }).toString("utf8"));
		} catch (error) {
			return this.drop(error instanceof SyntaxError ? "malformed" : "inflate");
		}
		if (!innerOk(inner)) return this.drop("malformed");
		if (inner.t === "ping") return;
		if (inner.t !== "part") return this.deps.onInner(inner);
		if (assembled) return this.drop("part-nested", "part");
		this.onPart(inner);
	}

	private onPart(p: OperateInner): void {
		const { of, i, n, bytes } = p;
		if (!isInt(of, 1, Number.MAX_SAFE_INTEGER) || !isInt(n, 2, OPERATE_LIMITS.maxParts) || !isInt(i, 0, n - 1) || typeof bytes !== "string") return this.drop("part-invalid", "part");
		const chunk = Buffer.from(bytes, "base64");
		if (chunk.length === 0 || chunk.length > OPERATE_LIMITS.partBytes) return this.drop("part-invalid", "part");
		let a = this.pending.get(of);
		if (a && a.n !== n) return (this.discard(of), this.drop("part-mismatch", "part"));
		if (a?.parts.has(i)) return (this.discard(of), this.drop("part-duplicate", "part"));
		if ((a?.bytes ?? 0) + chunk.length > OPERATE_LIMITS.messageBytes || this.pendingBytes + chunk.length > OPERATE_LIMITS.pendingBytes) return (a && this.discard(of), this.drop("part-limit", "part"));
		if (!a) {
			if (this.pending.size >= OPERATE_LIMITS.pendingMessages) return this.drop("part-limit", "part");
			a = { n, parts: new Map(), bytes: 0, last: 0 };
			this.pending.set(of, a);
		}
		a.parts.set(i, chunk);
		a.bytes += chunk.length;
		this.pendingBytes += chunk.length;
		a.last = this.deps.now();
		if (a.parts.size < a.n) return;
		const whole = Buffer.concat(Array.from({ length: a.n }, (_, k) => a!.parts.get(k)!));
		this.discard(of);
		this.take(whole, true);
	}

	private discard(of: number): void {
		const a = this.pending.get(of);
		if (!a) return;
		this.pendingBytes -= a.bytes;
		this.pending.delete(of);
	}

	/** One frame: the next counter, sealed with this end's key. The only place a frame is sealed. */
	private frame(deflated: Buffer): void {
		const keys = this.keys!, toBox = this.role === "operator";
		const ctr = ++this.sentCtr;
		this.lastSent = this.deps.now();
		this.emit({ session: this.id, type: "frame", ctr, ct: operateSeal({ key: toBox ? keys.subarray(0, 32) : keys.subarray(32), dir: toBox ? "toBox" : "toOperator", session: this.id, ctr, plaintext: deflated }) });
	}

	private emit(message: OperateMessage): void {
		try {
			const out = this.deps.send(message);
			if (out) out.catch((error) => this.deps.onTransportError(error));
		} catch (error) {
			this.deps.onTransportError(error);
		}
	}

	private drop(reason: DropReason, type?: string): void {
		this.deps.onDrop?.(type === undefined ? { reason } : { reason, type });
	}

	/** The one end of a session: state, keys zeroed, reassembly dropped, then the host told. */
	private finish(end: OperateEnd): void {
		if (this.status === "closed") return;
		this.status = "closed";
		this.keys?.fill(0);
		this.keys = this.mine = this.opening = undefined;
		this.pending.clear();
		this.pendingBytes = 0;
		this.deps.onEnd(end);
	}
}

/** The box's answer to an open it will not take: a `refuse` with a reason word. It makes no session and holds nothing. */
export function refuseOpen(deps: Pick<OperateDeps, "send" | "onTransportError">, session: Buffer, reason: string): void {
	try {
		const out = deps.send({ session, type: "refuse", reason });
		if (out) out.catch((error) => deps.onTransportError(error));
	} catch (error) {
		deps.onTransportError(error);
	}
}

/**
 * The box's book of sessions (§5.2, Replay): a session id it has seen is refused, and so is a third open session for one operator device in one team or a seventh on the box. An id is
 * remembered for `seenMs` after it was admitted, released or not, so a replay of an old `open` finds it; the holder drops an `open` older than 60 s on its own.
 */
export class OperateRegistry {
	private readonly now: () => number;
	private readonly seen = new Map<string, number>();
	private readonly open = new Map<string, string>();

	constructor(now: () => number) {
		this.now = now;
	}

	/** How many ids it remembers. */
	get size(): number {
		return this.seen.size;
	}

	/** `ok` takes a slot: `release` it when the session ends. Any other word is the refusal's reason. A refused id is remembered as well. */
	admit(team: string, operator: string, session: Buffer): "ok" | "seen" | "operator-limit" | "box-limit" {
		const now = this.now(), id = session.toString("hex");
		for (const [k, until] of this.seen) if (until <= now) this.seen.delete(k);
		if (this.seen.has(id)) return "seen";
		this.seen.set(id, now + OPERATE_LIMITS.seenMs);
		const owner = `${team}/${operator}`;
		if ([...this.open.values()].filter((o) => o === owner).length >= OPERATE_LIMITS.perOperator) return "operator-limit";
		if (this.open.size >= OPERATE_LIMITS.perBox) return "box-limit";
		this.open.set(id, owner);
		return "ok";
	}

	/** Frees the slot of a session that ended. Its id stays seen. */
	release(session: Buffer): void {
		this.open.delete(session.toString("hex"));
	}
}
