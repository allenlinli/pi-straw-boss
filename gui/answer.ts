import type { Post } from "./composer.ts";
import { type AnswerPost, mountAsk } from "./ask.ts";
import { type Answer, post } from "./post.ts";
import type { TrustPost } from "./trust.ts";

// How the page answers, decided once for Standard, Geek, and Zen: where an answer goes, whether a card may answer, what a reply meant, and the question panel's wiring (the panel's inside is ask.ts's).
export type SessionPost = (action: string, body: Record<string, unknown>) => Promise<Answer>;
/** An answer's route: the demo fixture's, else a pane an answer opened by its grant (mirror.ts, src/answerpane.ts), else the session. */
export const answerPost = (key: string, fixture?: (key: string) => Post | SessionPost | undefined): SessionPost => (fixture?.(key) as SessionPost | undefined) ?? ((action, body) => post(key.startsWith("grant:") ? `panes/${encodeURIComponent(key.slice(6))}/${action}` : `sessions/${encodeURIComponent(key)}/${action}`, body));
export const trustPost = (fixture?: TrustPost): TrustPost => fixture ?? ((body) => post("trust/answer", body));
/** A card answers only while its unit waits and every other fact its view reads (the stream is live, the unit takes control) is true. */
export const canAnswer = (mark: string, ...facts: boolean[]) => mark === "waiting" && facts.every(Boolean);
/** What a reply meant, read once: the owner took it, did not say (Check again), or it was refused. */
export const outcomeOf = (r: Answer): "accepted" | "unknown" | "refused" => (r.body.outcome === "accepted" ? "accepted" : r.body.outcome === "unknown" || r.status === 504 ? "unknown" : "refused");
/** A unit's question panel: `post` is where its answers go, `remote` to the host name, `show` opens its terminal, `accepted` hears an answer that landed. */
export const mountAnswer = (root: HTMLElement, { key, show, post, remote, accepted, label }: { key: string; show(): void; post: AnswerPost; remote?: boolean; accepted?: (opened: boolean) => void; label?: () => string }) => mountAsk(root, post, remote, { key, show }, accepted, label);
