import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { dec, enc, exact, int, str } from "./canon.ts";

// The primitives of Straw Link (docs/specs/2026-10-25-straw-link.md, Cryptography), Node's built-in crypto only. Every function that
// needs a nonce or an ephemeral key takes it as an optional argument, so the test vectors can fix it; without one it is random.

/** The context every signature and MAC starts with. */
export const CONTEXT = {
	envelope: "straw-link/envelope/1",
	roster: "straw-link/roster/1",
	request: "straw-link/request/1",
	join: "straw-link/join/1",
} as const;
const SEAL_INFO = "straw-link/seal/1", JOIN_KEY_INFO = "straw-link/join-key/1", LABELS_INFO = "straw-link/labels/1";

export const TEAM_ID_BYTES = 16, KEY_BYTES = 32, NONCE_BYTES = 12, TAG_BYTES = 16;

const concat = (...parts: Uint8Array[]) => Buffer.concat(parts);
export const sha256 = (...parts: Uint8Array[]): Buffer => {
	const h = createHash("sha256");
	for (const p of parts) h.update(p);
	return h.digest();
};
export const randomNonce = () => randomBytes(NONCE_BYTES);
export const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

// Raw key bytes go in and out of Node's KeyObjects through the fixed DER prefixes of RFC 8410.
const PKCS8 = { ed25519: "302e020100300506032b657004220420", x25519: "302e020100300506032b656e04220420" };
const SPKI = { ed25519: "302a300506032b6570032100", x25519: "302a300506032b656e032100" };
type Curve = keyof typeof PKCS8;

export const privateKeyOf = (curve: Curve, seed: Uint8Array): KeyObject => createPrivateKey({ key: concat(Buffer.from(PKCS8[curve], "hex"), exact(seed, 32, "a key seed")), format: "der", type: "pkcs8" });
export const publicKeyOf = (curve: Curve, raw: Uint8Array): KeyObject => createPublicKey({ key: concat(Buffer.from(SPKI[curve], "hex"), exact(raw, 32, "a public key")), format: "der", type: "spki" });
/** The raw 32 public bytes of a key (a private key gives its public half). */
export const publicBytes = (key: KeyObject): Buffer => createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);

/** Context ‖ team id ‖ the rest, the bytes every signature and MAC covers. */
export const signedBytes = (context: string, team: Uint8Array, ...rest: Uint8Array[]): Buffer => concat(Buffer.from(context, "utf8"), exact(team, TEAM_ID_BYTES, "a team id"), ...rest);

export const signBytes = (key: KeyObject, message: Uint8Array): Buffer => sign(null, message, key);
/** Whether `sig` is an Ed25519 signature of `message` by the raw public key; false (never a throw) for anything malformed. */
export function verifyBytes(signPub: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
	try {
		return sig.length === 64 && verify(null, message, publicKeyOf("ed25519", signPub), sig);
	} catch {
		return false;
	}
}

export const hkdf = (ikm: Uint8Array, info: Uint8Array, length = 32): Buffer => Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, length));

/** ChaCha20-Poly1305: ciphertext ‖ 16-byte tag. */
export function aeadSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array = Buffer.alloc(0)): Buffer {
	const c = createCipheriv("chacha20-poly1305", exact(key, KEY_BYTES, "an AEAD key"), exact(nonce, NONCE_BYTES, "a nonce"), { authTagLength: TAG_BYTES });
	c.setAAD(aad, { plaintextLength: plaintext.length });
	return concat(c.update(plaintext), c.final(), c.getAuthTag());
}
/** The plaintext, or null when the tag does not verify. */
export function aeadOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array = Buffer.alloc(0)): Buffer | null {
	if (sealed.length < TAG_BYTES || nonce.length !== NONCE_BYTES || key.length !== KEY_BYTES) return null;
	try {
		const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_BYTES });
		d.setAAD(aad, { plaintextLength: sealed.length - TAG_BYTES });
		d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
		return concat(d.update(sealed.subarray(0, sealed.length - TAG_BYTES)), d.final());
	} catch {
		return null;
	}
}

const epochBytes = (epoch: number) => int(epoch);

/**
 * Seals a key to one device: a fresh X25519 key, HKDF-SHA256 of the shared secret with info `straw-link/seal/1 ‖ team ‖ epoch ‖ ephemeral
 * public ‖ recipient public`, ChaCha20-Poly1305 with that one-use key and a zero nonce. The result is `enc(ephemeral public, ct ‖ tag)`.
 */
export function sealKey(o: { team: Uint8Array; epoch: number; key: Uint8Array; recipientBoxPub: Uint8Array; ephemeralSeed?: Uint8Array }): Buffer {
	const eph = privateKeyOf("x25519", o.ephemeralSeed ?? randomBytes(32)), ephPub = publicBytes(eph);
	const oneUse = sealKeyFor(o.team, o.epoch, eph, publicKeyOf("x25519", o.recipientBoxPub), ephPub, o.recipientBoxPub);
	return enc(ephPub, aeadSeal(oneUse, Buffer.alloc(NONCE_BYTES), exact(o.key, KEY_BYTES, "the key to seal")));
}
/** The key a seal holds, or null when it does not open for this device. */
export function openSealedKey(o: { team: Uint8Array; epoch: number; sealed: Uint8Array; boxKey: KeyObject; boxPub: Uint8Array }): Buffer | null {
	try {
		const [ephPub, ct] = dec(o.sealed, 2) as [Buffer, Buffer];
		const oneUse = sealKeyFor(o.team, o.epoch, o.boxKey, publicKeyOf("x25519", exact(ephPub, 32, "a public key")), ephPub, o.boxPub);
		const key = aeadOpen(oneUse, Buffer.alloc(NONCE_BYTES), ct);
		return key?.length === KEY_BYTES ? key : null;
	} catch {
		return null;
	}
}
const sealKeyFor = (team: Uint8Array, epoch: number, mine: KeyObject, theirs: KeyObject, ephPub: Uint8Array, recipientPub: Uint8Array) =>
	hkdf(diffieHellman({ privateKey: mine, publicKey: theirs }), concat(Buffer.from(SEAL_INFO, "utf8"), team, epochBytes(epoch), ephPub, recipientPub));

/** A table or label under the team key of `epoch`: nonce ‖ ct ‖ tag, with `straw-link/labels/1 ‖ team ‖ epoch` as associated data. */
export const sealUnderTeamKey = (o: { team: Uint8Array; epoch: number; key: Uint8Array; plaintext: Uint8Array; nonce?: Uint8Array }): Buffer => {
	const nonce = o.nonce ?? randomNonce();
	return concat(nonce, aeadSeal(o.key, nonce, o.plaintext, concat(Buffer.from(LABELS_INFO, "utf8"), o.team, epochBytes(o.epoch))));
};
export const openUnderTeamKey = (o: { team: Uint8Array; epoch: number; key: Uint8Array; sealed: Uint8Array }): Buffer | null =>
	o.sealed.length < NONCE_BYTES ? null : aeadOpen(o.key, o.sealed.subarray(0, NONCE_BYTES), o.sealed.subarray(NONCE_BYTES), concat(Buffer.from(LABELS_INFO, "utf8"), o.team, epochBytes(o.epoch)));

/** The key a join request is encrypted under: HKDF-SHA256(invite secret, info `straw-link/join-key/1 ‖ team`). */
export const joinKey = (secret: Uint8Array, team: Uint8Array): Buffer => hkdf(secret, concat(Buffer.from(JOIN_KEY_INFO, "utf8"), team));
/** HMAC-SHA256 keyed by the invite secret over `straw-link/join/1 ‖ team ‖ fields`. */
export const joinMac = (secret: Uint8Array, team: Uint8Array, fields: Uint8Array): Buffer => createHmac("sha256", secret).update(signedBytes(CONTEXT.join, team, fields)).digest();

/** What a relay request's signature covers: `straw-link/request/1 ‖ team ‖ enc(method, path with query, time, sha256(body))`. */
export const requestBytes = (o: { team: Uint8Array; method: string; path: string; time: number; body: Uint8Array }): Buffer =>
	signedBytes(CONTEXT.request, o.team, enc(str(o.method), str(o.path), int(o.time), sha256(o.body)));

// ---- Operate sessions (docs/specs/2026-11-07-link-operate.md §5.2) ---------------------------------------------------------------------------------

const OPERATE_INFO = "straw-link/operate/1";
/** The 4-byte direction tag that opens a frame's nonce: the operator's frames to the box, and the box's to the operator. */
const OPERATE_DIR = { toBox: Buffer.from([0, 0, 0, 1]), toOperator: Buffer.from([0, 0, 0, 2]) } as const;
export type OperateDir = keyof typeof OPERATE_DIR;

/** An ephemeral X25519 key of one session; the private half stays in memory and is dropped at close. A seed is for the vectors only. */
export function operateEphemeral(seed: Uint8Array = randomBytes(32)): { key: KeyObject; pub: Buffer } {
	const key = privateKeyOf("x25519", seed);
	return { key, pub: publicBytes(key) };
}

/**
 * The two keys of a session: `HKDF-SHA256(X25519(mine, theirs), salt = empty, info = "straw-link/operate/1" ‖ team ‖ session ‖ operator id ‖ box id ‖ ephOp ‖ ephBox)`,
 * 64 bytes. The first 32 key operator → box, the last 32 box → operator. Both ends compute the same pair: `mine` is this end's ephemeral private key, `theirs` the other's public one.
 */
export function operateKeys(o: { team: Uint8Array; session: Uint8Array; operator: string; box: string; ephOp: Uint8Array; ephBox: Uint8Array; mine: KeyObject; theirs: Uint8Array }): { toBox: Buffer; toOperator: Buffer } {
	const info = concat(Buffer.from(OPERATE_INFO, "utf8"), exact(o.team, TEAM_ID_BYTES, "a team id"), exact(o.session, 16, "a session id"), Buffer.from(o.operator, "utf8"), Buffer.from(o.box, "utf8"), exact(o.ephOp, 32, "an ephemeral key"), exact(o.ephBox, 32, "an ephemeral key"));
	const k = hkdf(diffieHellman({ privateKey: o.mine, publicKey: publicKeyOf("x25519", o.theirs) }), info, 64);
	return { toBox: k.subarray(0, 32), toOperator: k.subarray(32) };
}

const frameParts = (session: Uint8Array, ctr: number, dir: OperateDir) => {
	if (!Number.isSafeInteger(ctr) || ctr < 1) throw new RangeError("a frame counter starts at 1");
	const n = int(ctr);
	return { nonce: concat(OPERATE_DIR[dir], n), aad: concat(exact(session, 16, "a session id"), n) };
};
/** A frame's ciphertext (with its tag): ChaCha20-Poly1305, nonce = direction tag ‖ 8-byte `ctr`, AAD = `session ‖ ctr`. */
export function operateSeal(o: { key: Uint8Array; dir: OperateDir; session: Uint8Array; ctr: number; plaintext: Uint8Array }): Buffer {
	const { nonce, aad } = frameParts(o.session, o.ctr, o.dir);
	return aeadSeal(o.key, nonce, o.plaintext, aad);
}
/** The plaintext of a frame, or null when it does not open (wrong key, direction, session or counter). The caller keeps the counter rule. */
export function operateOpen(o: { key: Uint8Array; dir: OperateDir; session: Uint8Array; ctr: number; ct: Uint8Array }): Buffer | null {
	try {
		const { nonce, aad } = frameParts(o.session, o.ctr, o.dir);
		return aeadOpen(o.key, nonce, o.ct, aad);
	} catch {
		return null;
	}
}
