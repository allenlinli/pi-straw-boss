import { createConnection } from "node:net";
import { PROTOCOL, proofOf } from "../src/server/socket.ts";

/**
 * A raw client of the control socket's handshake (protocol 2): hello with a nonce, then, once the challenge has arrived, `auth` made from `secret` and the `requests`, all in one write.
 * `proof` replaces the auth proof (a forged or reflected one); `v` replaces the hello's version. Resolves with every line the server wrote, and whether it closed the connection.
 */
export function rawControl(endpoint: string, secret: string, requests: unknown[], { proof, v = PROTOCOL, waitMs = 300 }: { proof?: (challenge: { nonce: string; proof: string }, clientNonce: string) => string; v?: number; waitMs?: number } = {}) {
	return new Promise<{ lines: Record<string, unknown>[]; closed: boolean }>((resolve) => {
		const clientNonce = "c".repeat(32), lines: Record<string, unknown>[] = [];
		let buffer = "", closed = false, answered = false;
		const conn = createConnection(endpoint).setEncoding("utf8");
		conn.on("connect", () => conn.write(`${JSON.stringify({ cmd: "hello", v, nonce: clientNonce })}\n`));
		conn.on("data", (chunk: string) => {
			buffer += chunk;
			for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
				const frame = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
				buffer = buffer.slice(at + 1);
				lines.push(frame);
				if (!answered && typeof frame.nonce === "string") {
					answered = true;
					const challenge = { nonce: frame.nonce, proof: String(frame.proof) };
					conn.write([{ cmd: "auth", proof: proof ? proof(challenge, clientNonce) : proofOf(secret, "client", clientNonce, challenge.nonce) }, ...requests].map((f) => `${JSON.stringify(f)}\n`).join(""));
				}
			}
		});
		conn.on("close", () => (closed = true));
		conn.on("error", () => {});
		setTimeout(() => (conn.destroy(), resolve({ lines, closed })), waitMs);
	});
}
