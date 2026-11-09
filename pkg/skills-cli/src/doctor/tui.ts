import { homedir } from "node:os";
import { join } from "node:path";
import { updateJsonFile } from "../hooks/settings/json-file";
import { type Group, groupReport } from "./groups";
import type { DoctorReport } from "./types";

export type TuiDeps = {
	keys: AsyncIterable<string>;
	write(text: string): void;
	rerun(): Promise<DoctorReport>;
	runCommand(argv: string[]): Promise<number>;
	addAllowRules(rules: string[]): Promise<void>;
	size(): { rows: number; columns: number };
};

const ICON = { ok: "✅", info: "ℹ️", warn: "⚠️", fail: "❌" } as const;
const CLEAR = "\u001b[2J\u001b[H";
const HELP = "↑↓ move · → expand · ← collapse · enter fix · q quit";

export const KEY = {
	up: "\u001b[A",
	down: "\u001b[B",
	right: "\u001b[C",
	left: "\u001b[D",
	enter: "\r",
	ctrlC: "\u0003",
} as const;

type State = { groups: Group[]; cursor: number; open: Set<string>; status: string };

function hint(group: Group): string {
	if (group.action?.kind === "run") return `enter: ${group.action.argv.join(" ")}`;
	if (group.action?.kind === "allow-rule") return "enter: add all to ~/.claude/settings.json";
	return group.fix ? "fix by hand" : "";
}

const MIN_MEMBERS = 3;

function clip(line: string, columns: number): string {
	const chars = [...line];
	return chars.length <= columns ? line : `${chars.slice(0, Math.max(1, columns - 1)).join("")}…`;
}

function header(group: Group, selected: boolean): string {
	const tail = hint(group);
	return `${selected ? ">" : " "} ${ICON[group.status]} ${group.title}${tail ? `    ${tail}` : ""}`;
}

/** Draws one screen: rows clipped to the terminal width, scrolled so the cursor row and its details show. */
export function render(state: State, size: { rows: number; columns: number }): string {
	const body = Math.max(1, size.rows - 2);
	const room = Math.max(MIN_MEMBERS, body - state.groups.length - 1);
	const lines: string[] = [];
	let cursorStart = 0;
	let cursorEnd = 0;
	state.groups.forEach((group, index) => {
		const selected = index === state.cursor;
		if (selected) cursorStart = lines.length;
		lines.push(header(group, selected));
		if (state.open.has(group.key)) {
			const shown = group.members.slice(0, room);
			for (const { item, check } of shown) lines.push(`      ${item} · ${check.id}: ${check.detail}`);
			const hidden = group.members.length - shown.length;
			if (hidden > 0) lines.push(`      … ${hidden} more; dg-skills doctor --plain lists all`);
			if (group.fix && group.action?.kind !== "allow-rule") lines.push(`      Fix: ${group.fix}`);
		}
		if (selected) cursorEnd = lines.length - 1;
	});
	const top = Math.min(cursorStart, Math.max(0, cursorEnd - body + 1));
	const visible = lines.slice(top, top + body).map((line) => clip(line, size.columns));
	visible.push("", clip(state.status || HELP, size.columns));
	return `${CLEAR}${visible.join("\n")}\n`;
}

/** Splits raw terminal input into keys; an unfinished escape sequence stays in `rest`. */
export function splitKeys(buffer: string): { keys: string[]; rest: string } {
	const keys: string[] = [];
	let at = 0;
	while (at < buffer.length) {
		if (buffer[at] === "\u001b") {
			if (buffer.length - at < 3) break;
			keys.push(buffer.slice(at, at + 3));
			at += 3;
		} else {
			keys.push(buffer[at] as string);
			at += 1;
		}
	}
	return { keys, rest: buffer.slice(at) };
}

async function nextKey(keys: AsyncIterator<string>): Promise<string> {
	const next = await keys.next();
	return next.done ? "q" : next.value;
}

function prompt(group: Group): string | null {
	if (group.action?.kind === "run") return `Run ${group.action.argv.join(" ")}? [y/N]`;
	if (group.action?.kind === "allow-rule")
		return `Add ${group.action.rules.length} allow rules to ~/.claude/settings.json? [y/N]  (→ lists them)`;
	return null;
}

async function apply(group: Group, deps: TuiDeps): Promise<string> {
	const action = group.action;
	if (action?.kind === "run") {
		const code = await deps.runCommand(action.argv);
		return `${action.argv.join(" ")} exited ${code}.`;
	}
	if (action?.kind === "allow-rule") {
		await deps.addAllowRules(action.rules);
		return `Added ${action.rules.length} allow rules.`;
	}
	return "";
}

/** Runs the doctor TUI until q; returns the last report. */
export async function runTui(report: DoctorReport, deps: TuiDeps): Promise<DoctorReport> {
	const keys = deps.keys[Symbol.asyncIterator]();
	let current = report;
	const state: State = { groups: groupReport(report), cursor: 0, open: new Set(), status: "" };
	for (;;) {
		deps.write(render(state, deps.size()));
		state.status = "";
		const key = await nextKey(keys);
		const group = state.groups[state.cursor];
		if (key === "q" || key === KEY.ctrlC) return current;
		if (key === KEY.up) state.cursor = Math.max(0, state.cursor - 1);
		else if (key === KEY.down) state.cursor = Math.min(state.groups.length - 1, state.cursor + 1);
		else if (key === KEY.right && group) state.open.add(group.key);
		else if (key === KEY.left && group) state.open.delete(group.key);
		else if (key === KEY.enter && group) {
			const question = prompt(group);
			if (question === null) {
				state.status = group.fix ? `Run this yourself: ${group.fix}` : "Nothing to fix here.";
				continue;
			}
			state.status = question;
			deps.write(render(state, deps.size()));
			if ((await nextKey(keys)).toLowerCase() !== "y") {
				state.status = "Skipped.";
				continue;
			}
			let done: string;
			try {
				done = await apply(group, deps);
			} catch (error) {
				done = `Fix failed: ${error instanceof Error ? error.message : String(error)}`;
			}
			current = await deps.rerun();
			state.groups = groupReport(current);
			state.cursor = Math.min(state.cursor, state.groups.length - 1);
			state.status = done;
		}
	}
}

/** Adds rules to permissions.allow in ~/.claude/settings.json and keeps every other key and rule. */
export function addAllowRules(rules: string[], home: string = process.env.HOME ?? homedir()): Promise<void> {
	return updateJsonFile(join(home, ".claude", "settings.json"), (doc) => {
		const permissions =
			typeof doc.permissions === "object" && doc.permissions !== null && !Array.isArray(doc.permissions)
				? (doc.permissions as Record<string, unknown>)
				: {};
		const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
		const added = rules.filter((rule) => !allow.includes(rule));
		return { ...doc, permissions: { ...permissions, allow: [...allow, ...added] } };
	});
}

/** Turns raw stdin chunks into a key stream that can stop listening while a child owns the terminal. */
function keyStream(stdin: NodeJS.ReadStream) {
	const queue: string[] = [];
	let waiting: ((key: string) => void) | null = null;
	let pending = "";
	const onData = (chunk: string) => {
		const split = splitKeys(pending + chunk);
		pending = split.rest;
		for (const key of split.keys) {
			if (waiting) {
				const resolve = waiting;
				waiting = null;
				resolve(key);
			} else queue.push(key);
		}
	};
	const listen = () => {
		stdin.setRawMode(true);
		stdin.on("data", onData);
		stdin.resume();
	};
	const stop = () => {
		stdin.off("data", onData);
		stdin.pause();
		stdin.setRawMode(false);
	};
	const keys: AsyncIterable<string> = {
		[Symbol.asyncIterator]: () => ({
			next: () =>
				new Promise<IteratorResult<string>>((resolve) => {
					const queued = queue.shift();
					if (queued !== undefined) resolve({ value: queued, done: false });
					else waiting = (value) => resolve({ value, done: false });
				}),
		}),
	};
	return { keys, listen, stop };
}

/** Wires the TUI to the real terminal: raw keys, a cleared screen, and inherited stdio for a fix. */
export function terminalDeps(rerun: () => Promise<DoctorReport>): TuiDeps & { close(): void } {
	const stdin = process.stdin;
	stdin.setEncoding("utf8");
	const stream = keyStream(stdin);
	stream.listen();
	return {
		keys: stream.keys,
		write: (text) => process.stdout.write(text),
		rerun,
		runCommand: async (argv) => {
			stream.stop();
			process.stdout.write(`${CLEAR}$ ${argv.join(" ")}\n`);
			try {
				return await Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] }).exited;
			} finally {
				stream.listen();
			}
		},
		addAllowRules: (rules) => addAllowRules(rules),
		size: () => ({ rows: process.stdout.rows || 24, columns: process.stdout.columns || 80 }),
		close: stream.stop,
	};
}
