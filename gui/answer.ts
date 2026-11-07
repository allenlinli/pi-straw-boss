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
/** A unit's question panel: `post` is where its answers go, `remote` to the host name, `show` opens its terminal, `accepted` hears an answer that landed. */
export const mountAnswer = (root: HTMLElement, { key, show, post, remote, accepted, label, box }: { key: string; show(): void; post: AnswerPost; remote?: boolean; accepted?: (opened: boolean) => void; label?: () => string; /** The unit is a box's (operate): the page is a remote one to it whatever its own address, and a choice that opens a pane is refused. */ box?: boolean }) => mountAsk(root, post, box ? true : remote, { key, show }, accepted, label, box);
