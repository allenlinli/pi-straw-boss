import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { baseName, type Proc } from "./table.ts";

// The words of the removal guard (src/hygiene.ts): which worktrees a bash command removes, what `git worktree list --porcelain` says, and the lines of the refusal. Pure text work, so a table test needs no disk.
// Nothing here reads or prints a command line of another process: a holder is told by pid, program name (`comm`), cpu time, age and owner state.

/** A target a command removes: the word it gave (a path, a branch, or a workspace id) and the folder the command runs in by then. `via` is the program; a `herdr worktree remove` without `--workspace` has the empty target (Herdr then takes the caller's own workspace). */
export interface RemoveTarget { target: string; cwd: string; via: "git" | "herdr" }

/** One piece of a command: a word (quotes and backslashes resolved) or an operator the shell would split commands on. */
export type Token = { word: string } | { op: string };

/**
 * Splits a command into words and (with `ops`) the operators between commands, honoring single and double quotes and backslashes: an operator character inside quotes is part of a word. An unclosed quote runs to the end.
 * Best effort: expansion and substitution are not evaluated.
 */
export function lex(text: string, ops = true): Token[] {
	const out: Token[] = [];
	let word = "", open = false, quote: string | undefined;
	const flush = () => {
		if (open || word) out.push({ word });
		word = "";
		open = false;
	};
	const operator = (op: string) => (flush(), void out.push({ op }));
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!, next = text[i + 1];
		if (quote) {
			if (c === quote) quote = undefined;
			else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i]!;
			else word += c;
		} else if (c === "'" || c === '"') (quote = c, open = true);
		else if (c === "\\" && i + 1 < text.length) {
			// A backslash before a newline joins the lines.
			if (text[++i] !== "\n") (word += text[i]!, open = true);
		} else if (ops && (c === "\n" || c === "\r")) operator("\n");
		else if (/\s/.test(c)) flush();
		else if (!ops) (word += c, open = true);
		else if (c === ";") operator(";");
		else if (c === "&") {
			// `2>&1`, `>&2` and `&>` are redirections, `&&` and a lone `&` end a command.
			if (/[<>]$/.test(word) || next === ">") (word += c, open = true);
			else if (next === "&") (operator("&&"), i++);
			else operator("&");
		} else if (c === "|") {
			if (next === "|") (operator("||"), i++);
			else operator("|");
		} else if (c === "(" || c === ")" || c === "`") operator(c);
		else if (c === "$" && next === "(") (operator("("), i++);
		else if (c === "#" && !open && !word) {
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
		} else (word += c, open = true);
	}
	flush();
	return out;
}

/** The words of a text, quotes and backslashes resolved; operators are not told apart. */
export const words = (text: string): string[] => lex(text, false).flatMap((t) => ("word" in t ? [t.word] : []));

const expand = (path: string) => (path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path);
const REDIRECT = /^\d*(?:>>?|<{1,3}|&>>?|>&)/;

/**
 * The worktrees a bash command removes: every `git worktree remove` and `herdr worktree remove` among its commands, wherever it sits (after `&&`, `;`, a pipe, a subshell, or inside the quotes of `bash -c "…"`). Commands are
 * split on the operators outside quotes only. A `cd` and a `git -C` before it move the folder the target is read in, and a subshell's `cd` ends with the subshell. A command line has no more structure than that here: it
 * is the guard of a careless call, not of a shell written to get around it.
 */
export function removeTargets(command: string, cwd: string, depth = 0): RemoveTarget[] {
	const out: RemoveTarget[] = [];
	let here = cwd, current: string[] = [], tick = false;
	const saved: string[] = [];
	const run = () => {
		const tokens: string[] = [];
		for (let i = 0; i < current.length; i++) {
			if (!REDIRECT.test(current[i]!)) tokens.push(current[i]!);
			else if (/^\d*(?:>>?|<{1,3}|&>>?|>&)$/.test(current[i]!)) i++; // the file of a redirection is not an argument
		}
		current = [];
		if (tokens[0] === "cd" && tokens[1] && tokens[1] !== "-") here = resolve(here, expand(tokens[1]));
		// The word after `-c` of a shell (`bash -c "…"`, `sh -lc '…'`) or after `eval` is a command of its own.
		if (depth < 3) tokens.forEach((token, at) => /\s/.test(token) && (/^-[A-Za-z]*c$/.test(tokens[at - 1] ?? "") || tokens[at - 1] === "eval") && out.push(...removeTargets(token, here, depth + 1)));
		for (let i = 0; i < tokens.length; i++) {
			const tool = basename(tokens[i]!);
			if (tool !== "git" && tool !== "herdr") continue;
			let at = here, j = i + 1;
			// Options before the subcommand: `git -C <dir>`, `git -c k=v`, `git --git-dir=…`.
			for (; j < tokens.length && tokens[j] !== "worktree"; j++) {
				if (tokens[j] === "-C" && tokens[j + 1]) at = resolve(at, expand(tokens[++j]!));
				else if ((tokens[j] === "-c" || tokens[j] === "--git-dir" || tokens[j] === "--work-tree") && tokens[j + 1]) j++;
				else if (!tokens[j]!.startsWith("-")) break;
			}
			if (tokens[j] !== "worktree" || tokens[j + 1] !== "remove") continue;
			const before = out.length;
			let flags = true;
			for (let k = j + 2; k < tokens.length; k++) {
				const word = tokens[k]!;
				if (flags && word === "--") flags = false;
				else if (flags && word === "--workspace" && tokens[k + 1]) out.push({ target: tokens[++k]!, cwd: at, via: tool });
				else if (flags && word.startsWith("--workspace=")) out.push({ target: word.slice("--workspace=".length), cwd: at, via: tool });
				else if (flags && word.startsWith("-")) continue;
				else out.push({ target: word, cwd: at, via: tool });
			}
			// Herdr takes the workspace of the caller when none is named.
			if (tool === "herdr" && out.length === before) out.push({ target: "", cwd: at, via: "herdr" });
			i = tokens.length;
		}
	};
	for (const token of lex(command)) {
		if ("word" in token) {
			current.push(token.word);
			continue;
		}
		run();
		if (token.op === "(") saved.push(here);
		else if (token.op === ")") here = saved.pop() ?? here;
		else if (token.op === "`") (tick ? (here = saved.pop() ?? here) : saved.push(here), tick = !tick);
	}
	run();
	return out;
}

export interface ListedWorktree { path: string; branch?: string }
/** The entries of `git worktree list --porcelain`; the first is the main checkout. */
export function parseWorktreeList(text: string): ListedWorktree[] {
	const out: ListedWorktree[] = [];
	for (const block of text.split(/\n\s*\n/)) {
		let path: string | undefined, branch: string | undefined;
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
			else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
		}
		if (path) out.push({ path, ...(branch ? { branch } : {}) });
	}
	return out;
}

/** What the guard says about one process that works in the checkout. */
export interface Holder { proc: Proc; owner?: { id: string; state: "live" | "ended" | "unknown"; reason?: string }; orphan: boolean }

const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 64);
export const cpuText = (seconds: number) => (seconds < 60 ? `${Math.round(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s` : `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`);
/** The age of a process from its `ps` start time (UTC text), "?" when the text is not a date. */
export function ageText(started: string, now: number): string {
	const began = Date.parse(`${started} UTC`);
	if (!Number.isFinite(began) || now < began) return "?";
	const minutes = Math.floor((now - began) / 60_000);
	return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m` : `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`;
}
const ownerText = (h: Holder) => (!h.owner ? "no owner marker" : h.owner.state === "live" ? `owner ${clean(h.owner.id)} (live)` : h.owner.state === "ended" ? `owner ${clean(h.owner.id)} (ended: ${clean(h.owner.reason ?? "?")})` : `owner ${clean(h.owner.id)} (not known to the server)`);
const shell = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

const LISTED = 12;
/** The refusal of a removal: the holders (pid, comm, cpu, age, owner state; never a command line) and the command that reaps what an ended worker left. */
export function refusal(what: string, root: string, holders: readonly Holder[], reap: string, now: number): string {
	const rows = holders.slice(0, LISTED).map((h) => `- pid ${h.proc.pid} ${clean(baseName(h.proc.comm))}, cpu ${cpuText(h.proc.cpu)}, age ${ageText(h.proc.started, now)}, ${ownerText(h)}${h.orphan ? ", orphan" : ""}`);
	return [
		`${what} refused: ${holders.length} process${holders.length === 1 ? "" : "es"} work${holders.length === 1 ? "s" : ""} in ${root}`,
		...rows, ...(holders.length > LISTED ? [`- and ${holders.length - LISTED} more`] : []),
		`If an ended worker left them, stop them with: ${reap} procs reap --checkout ${shell(root)}`,
		"A process of a live worker or pane is not reaped: end that worker or close that pane first. Then repeat this call.",
	].join("\n");
}
