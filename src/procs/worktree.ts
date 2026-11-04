import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";

// Which checkout a working folder belongs to. A linked worktree has a `.git` *file* (`gitdir: <repo>/.git/worktrees/<name>`), a main checkout a `.git` folder, a submodule a `.git` file into `.git/modules/`.

export type Checkout =
	| { kind: "linked"; root: string; gitdir: string }
	| { kind: "main"; root: string }
	| { kind: "submodule"; root: string }
	| { kind: "none" };

/** The two facts the walk needs from the disk; injected so a table test needs no disk. */
export interface Disk { kind(path: string): "file" | "dir" | undefined; read(path: string): string | undefined }
export const realDisk: Disk = {
	kind: (path) => {
		try {
			return statSync(path).isDirectory() ? "dir" : "file";
		} catch {
			return undefined;
		}
	},
	read: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
};

/** The nearest `.git` going up from `cwd` decides. */
export function checkoutOf(cwd: string, disk: Disk = realDisk): Checkout {
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		const git = join(dir, ".git"), kind = disk.kind(git);
		if (kind === "dir") return { kind: "main", root: dir };
		if (kind === "file") {
			const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(disk.read(git) ?? "")?.[1];
			if (gitdir && /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitdir)) return { kind: "linked", root: dir, gitdir };
			if (gitdir && /[\\/]modules[\\/]/.test(gitdir)) return { kind: "submodule", root: dir };
			return { kind: "none" };
		}
		if (dirname(dir) === dir) return { kind: "none" };
	}
}

/** Whether `path` is `root` or below it (a sibling that shares a prefix is not). */
export function under(path: string, root: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The longest known root above a vanished folder: the checkout it was last seen as part of. */
export function rootOfRemoved(path: string, roots: readonly string[]): string | undefined {
	return roots.filter((root) => under(path, root)).sort((a, b) => b.length - a.length)[0];
}
