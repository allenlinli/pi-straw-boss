// What a block's answer locked, as the page holds it (docs/specs/2026-11-07-better-show-host.md, "Answered"). The record itself is the server's (src/answered.ts), read when a message or document is drawn (answered.ts, doc.ts); this is the page's live copy of it, one cell per
// scope the host names (a chat message: its session and entry; a document: its capability and the hash of its text) and block index, so that every drawing of one block on this page shows the same state: open, pending (its answer is on its way: locked, with no fields to
// show yet), or done with the fields that went. A redraw (a tool result, a reconnect) therefore finds a block that is being answered locked, not open. Nothing is written to the browser's storage. A cell reopens in two cases only: the delivery this page was waiting for is refused, or the record had shown it as on its way (another device's answer, or a 504)
// and a later record no longer lists it (the answer was refused, or never confirmed and expired).

/** The fields a locked block shows: 64 questions and the reserved pi-note (pi-better-show 0.5.0 puts it last), as the server keeps them (src/documents.ts MAX_FIELDS). */
const MAX_LOCKED = 65;
export type Fields = readonly (readonly [string, string])[];
export type Cell = { state: "open" } | { state: "pending" } | { state: "done"; fields: Fields };
/** A drawing of a block, told when its cell changes. The lock holds it weakly: a drawing that has gone is forgotten. */
export interface View { show(cell: Cell): void }
/** What the server's record says of a scope's blocks. */
export interface Record_ { done: [number, Fields][]; pending: number[] }
export interface BlockLock {
	get(index: number): Cell;
	/** The answer is on its way. */
	pend(index: number): void;
	/** The owner took it. */
	done(index: number, fields: Fields): void;
	/** The delivery was refused: the block is open again. */
	cancel(index: number): void;
	/** The server's record: what it says is answered becomes done, what it says is on its way becomes pending; a block it says nothing of keeps its cell, except one that an earlier record made pending and this page is not sending itself, which opens again. */
	seed(record: Record_): void;
	watch(index: number, view: View): void;
}

const MAX = 2000;
/** `seeded`: the cell is pending because a record said so, not because this page is sending it. */
type Slot = { cell: Cell; views: Set<WeakRef<View>>; seeded?: true };
const shared = new Map<string, Slot>();
/** Forgets everything the page holds (for a test, standing in for a reload). */
export const forgetLocks = () => shared.clear();

function make(slots: Map<string, Slot>, scope: string[]): BlockLock {
	const slot = (index: number) => {
		const key = JSON.stringify([...scope, index]);
		let s = slots.get(key);
		if (!s) {
			for (const [k, v] of slots) if (slots.size >= MAX && v.cell.state !== "pending") slots.delete(k); // the oldest that is not in flight
			slots.set(key, (s = { cell: { state: "open" }, views: new Set() }));
		}
		return s;
	};
	const set = (index: number, cell: Cell, seeded?: true) => {
		const s = slot(index);
		s.cell = cell;
		if (seeded) s.seeded = true;
		else delete s.seeded;
		for (const ref of s.views) {
			const view = ref.deref();
			if (view) view.show(cell);
			else s.views.delete(ref);
		}
	};
	return {
		get: (index) => slot(index).cell,
		pend: (index) => set(index, { state: "pending" }),
		done: (index, fields) => set(index, { state: "done", fields: fields.slice(0, MAX_LOCKED) }),
		cancel: (index) => set(index, { state: "open" }),
		seed({ done, pending }) {
			const listed = new Set([...done.map(([index]) => index), ...pending]);
			for (const [key, s] of slots) {
				const parts = JSON.parse(key) as unknown[], index = parts.at(-1) as number;
				if (s.seeded && s.cell.state === "pending" && parts.length === scope.length + 1 && scope.every((part, i) => parts[i] === part) && !listed.has(index)) set(index, { state: "open" });
			}
			for (const [index, fields] of done) set(index, { state: "done", fields: fields.slice(0, MAX_LOCKED) });
			for (const index of pending) if (slot(index).cell.state === "open") set(index, { state: "pending" }, true);
		},
		watch: (index, view) => void slot(index).views.add(new WeakRef(view)),
	};
}

/** The lock of one scope (a chat message, a document's text). Without a scope the host keeps nothing across drawings: the lock is private to the drawing that asks. */
export const lockFor = (...scope: string[]): BlockLock => make(scope.length ? shared : new Map(), scope);
