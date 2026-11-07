// What a block's answer locked, kept by the page so that a reload shows the block locked with the fields that were sent (pi-better-show's `answered`). The key is the scope the host names (a chat message: its session and entry; a
// document: its capability and revision) and the block's index in the text. The store is `localStorage` (the page's own origin, this browser), at most MAX answers, the oldest dropped first; a browser that refuses it keeps them in memory.

type Fields = readonly (readonly [string, string])[];
export interface BlockLock { get(index: number): Fields | undefined; set(index: number, fields: Fields): void }

const SLOT = "sb-answered", MAX = 300, MAX_BYTES = 16_384;
const memory = new Map<string, Fields>(); // only for a browser that refuses the store
const read = (): [string, Fields][] => {
	const list = JSON.parse(localStorage.getItem(SLOT) ?? "[]") as unknown;
	return Array.isArray(list) ? list.filter((e): e is [string, Fields] => Array.isArray(e) && typeof e[0] === "string" && Array.isArray(e[1])) : [];
};
const keyOf = (scope: string[], index: number) => `${scope.join("\u001f")}\u001f${index}`;

export function lockFor(...scope: string[]): BlockLock {
	return {
		get(index) {
			const key = keyOf(scope, index);
			try {
				return read().find(([k]) => k === key)?.[1];
			} catch {
				return memory.get(key); // storage refused, or holds something that is not ours
			}
		},
		set(index, fields) {
			const key = keyOf(scope, index), kept = JSON.stringify(fields).length <= MAX_BYTES ? fields : fields.map(([name, value]) => [name, value.slice(0, 1024)] as const);
			try {
				localStorage.setItem(SLOT, JSON.stringify([...read().filter(([k]) => k !== key), [key, kept]].slice(-MAX)));
			} catch {
				memory.set(key, kept);
				if (memory.size > MAX) memory.delete(memory.keys().next().value!);
			}
		},
	};
}
