import type { Item } from "../src/items.ts";
import type { Alert } from "./alerts.ts";
import type { Chat, Data, HistoryEvent, Who } from "./chat.ts";
import type { mountAsk } from "./ask.ts";
import type { mountComposer, Post } from "./composer.ts";
import type { Route } from "./router.ts";
import type { TrustPost, trustPanel } from "./trust.ts";
import type { Sound } from "./zenmodel.ts";
import type { With } from "./zenwith.ts";

// What the Zen layer (zen.ts) is given: the page's hooks and the panels it mounts.
/** Where leaving Zen goes (the page shows Standard first): an item's dialog opens over it (`item`), a session opens (`route`, in terminal mode with `terminal` its key), or nothing more. */
export interface Exit { item?: Alert; route?: Route; terminal?: string }
export interface ZenDeps {
	data(key: string): Data;
	recent(key: string): Promise<Item[]>;
	/** The demo fixture's stand-in for the server's session endpoints; unset: the server's. */
	post?(key: string): Post | undefined;
	trust?: TrustPost;
	label(ws: string): string;
	online(): boolean;
	/** The system notification for the item that took the screen while the page is hidden or unfocused. */
	remind(a: Alert): void;
	/** Z5 fills this with the effects; Zen makes no sound of its own here. */
	sound(s: Sound): void;
	leave(to: Exit): void;
	/** The session whose log the stream should send (the companion), or none. */
	watch(key: string | null): void;
	/** A paired device (`mountAsk`'s `remote`); unset: by the host name. */
	remote?: boolean;
	/** The session this device last talked to (zenwith.ts); unset: the stored one. */
	stored?(): With | undefined;
	now?: () => number;
	/** The page's timer (a test moves its own): runs `fn` after `ms` and returns what cancels it. */
	later?(fn: () => void, ms: number): () => void;
}
export type Mounts = { ask: typeof mountAsk; trust: typeof trustPanel; composer: typeof mountComposer; chat(): Promise<(root: HTMLElement, data: Data, deps: { who(): Who; link(): undefined }) => Chat> };
