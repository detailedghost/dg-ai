import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { protoDir, sentinelPaths } from "../src/prototype/paths";
import {
	awaitDecision,
	confirm,
	formatDecision,
	formatWait,
	readSource,
	status,
	wait,
	writeSentinel,
} from "../src/prototype/sentinels";
import { git, makeGitRepo, makeTempDir } from "./git-repo-fixtures";

let root: string;
let previousScratch: string | undefined;

beforeEach(() => {
	root = makeTempDir("dg-prototype-");
	previousScratch = process.env.AI_SCRATCH_DIR;
	process.env.AI_SCRATCH_DIR = join(root, "scratch");
	mkdirSync(process.env.AI_SCRATCH_DIR, { recursive: true });
});

afterEach(() => {
	if (previousScratch === undefined) delete process.env.AI_SCRATCH_DIR;
	else process.env.AI_SCRATCH_DIR = previousScratch;
	chmodSync(root, 0o700);
	rmSync(root, { recursive: true, force: true });
});

function paths(name = "demo") {
	return sentinelPaths(join(root, ".agents", "prototype", name));
}

describe("prototype sentinels", () => {
	test("confirm then wait returns the variant and notes and consumes both files", async () => {
		const p = paths();
		confirm(p, "B", "ship it");
		expect(status(p)).toBe("B");
		expect(await wait(p, 1)).toEqual({
			status: "ok",
			variant: "B",
			notes: "ship it",
		});
		expect(existsSync(p.selection)).toBe(false);
		expect(existsSync(p.notes)).toBe(false);
		expect(status(p)).toBe("pending");
	});

	test("confirm records its source as cli, and a claim consumes it too", async () => {
		const p = paths();
		confirm(p, "B");
		expect(readSource(p)).toBe("cli");
		await wait(p, 1);
		expect(existsSync(p.source)).toBe(false);
		expect(readSource(p)).toBeUndefined();
	});

	test("a browser-written selection with no .source reports no source", async () => {
		const p = paths();
		mkdirSync(p.dir, { recursive: true });
		writeFileSync(p.selection, "B\n");
		expect(readSource(p)).toBeUndefined();
	});

	test("a reject sentinel surfaces its notes and clears the reject and notes files", async () => {
		const p = paths();
		mkdirSync(p.dir, { recursive: true });
		writeFileSync(p.reject, "too busy\n");
		writeFileSync(p.notes, "stale");
		expect(status(p)).toBe("rejected");
		expect(await wait(p, 1)).toEqual({ status: "rejected", notes: "too busy" });
		expect(existsSync(p.reject)).toBe(false);
		expect(existsSync(p.notes)).toBe(false);
	});

	test("a bare newline reject carries empty notes", async () => {
		const p = paths();
		mkdirSync(p.dir, { recursive: true });
		writeFileSync(p.reject, "\n");
		expect(await wait(p, 1)).toEqual({ status: "rejected", notes: "" });
	});

	test("wait checks the sentinels once even with a zero timeout", async () => {
		const p = paths();
		confirm(p, "A");
		expect((await wait(p, 0)).status).toBe("ok");
	});

	test("wait times out when no decision arrives", async () => {
		const started = Date.now();
		expect(await wait(paths(), 1)).toEqual({ status: "timeout" });
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
	});

	test("wait wakes when a decision lands while it is blocked", async () => {
		const p = paths();
		const pending = wait(p, 5);
		setTimeout(() => confirm(p, "C"), 300);
		expect(await pending).toEqual({ status: "ok", variant: "C", notes: "" });
	});

	test("a removal failure warns on stderr and still reports the claim", async () => {
		if (process.getuid?.() === 0) return;
		const p = paths();
		confirm(p, "A");
		chmodSync(p.dir, 0o500);
		const writes: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			expect((await wait(p, 1)).status).toBe("ok");
		} finally {
			process.stderr.write = original;
			chmodSync(p.dir, 0o700);
		}
		expect(writes.join("")).toContain("could not remove consumed sentinel");
	});

	test("await-decision reads and consumes the plan decision", async () => {
		const p = paths();
		mkdirSync(p.dir, { recursive: true });
		writeFileSync(
			p.decision,
			`${JSON.stringify({ decision: "REWORK", notes: "n" })}\n`,
		);
		const result = await awaitDecision(p, 1);
		expect(result).toEqual({
			status: "ok",
			contents: '{"decision":"REWORK","notes":"n"}',
			decision: "REWORK",
		});
		expect(existsSync(p.decision)).toBe(false);
		expect(formatDecision(result, false)).toBe("REWORK\n");
		expect(formatDecision(result, true)).toBe(
			'{"decision":"REWORK","notes":"n"}\n',
		);
		expect(await awaitDecision(p, 0)).toEqual({ status: "timeout" });
	});

	test("output formats match the legacy wait contract", () => {
		expect(formatWait({ status: "ok", variant: "B", notes: "x" }, true)).toBe(
			'{"status":"ok","variant":"B","notes":"x"}\n',
		);
		expect(formatWait({ status: "ok", variant: "B", notes: "x" }, false)).toBe(
			"B\nx\n",
		);
		expect(formatWait({ status: "rejected", notes: "" }, false)).toBe(
			"rejected\n",
		);
		expect(formatWait({ status: "timeout" }, true)).toBe(
			'{"status":"timeout"}\n',
		);
		expect(formatWait({ status: "timeout" }, false)).toBe("timeout\n");
	});
});

describe("prototype directory resolution", () => {
	function addWorktree(main: string, name: string): string {
		const path = join(makeTempDir("dg-prototype-wt-"), name);
		git(["worktree", "add", "-q", "-b", name, path], main);
		return path;
	}

	function repo(): string {
		const main = makeGitRepo();
		git(["commit", "--allow-empty", "-q", "-m", "init"], main);
		return main;
	}

	const durable = (base: string, name: string) =>
		join(base, ".agents", "prototype", name);

	test("resolves from the root that holds the prototype and from inside it", () => {
		const main = repo();
		mkdirSync(durable(main, "local"), { recursive: true });
		expect(protoDir("local", { cwd: main, light: false })).toBe(
			durable(main, "local"),
		);
		expect(
			protoDir("local", { cwd: durable(main, "local"), light: false }),
		).toBe(durable(main, "local"));
	});

	test("finds the prototype in a sibling worktree", () => {
		const main = repo();
		const a = addWorktree(main, "wt-a");
		const b = addWorktree(main, "wt-b");
		mkdirSync(durable(a, "shared"), { recursive: true });
		expect(protoDir("shared", { cwd: b, light: false })).toBe(
			durable(a, "shared"),
		);
	});

	test("lists every candidate when the name exists in two worktrees", () => {
		const main = repo();
		const a = addWorktree(main, "wt-a");
		const b = addWorktree(main, "wt-b");
		mkdirSync(durable(a, "dup"), { recursive: true });
		mkdirSync(durable(b, "dup"), { recursive: true });
		let message = "";
		try {
			protoDir("dup", { cwd: main, light: false });
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain('ambiguous prototype "dup"');
		expect(message).toContain(durable(a, "dup"));
		expect(message).toContain(durable(b, "dup"));
	});

	test("falls back to the working directory for a new prototype", () => {
		const main = repo();
		expect(protoDir("fresh", { cwd: main, light: false })).toBe(
			durable(main, "fresh"),
		);
	});

	test("light mode resolves under the scratch root and ignores the search", () => {
		const main = repo();
		mkdirSync(durable(main, "light"), { recursive: true });
		const dir = protoDir("light", { cwd: main, light: true });
		expect(dir.startsWith(join(root, "scratch", "prototype"))).toBe(true);
		expect(dir.endsWith("/light")).toBe(true);
	});

	test.each(["", ".", "..", "a/b", "a\\b", "..%2f..%2fx", "..%5Cx", "/abs"])("rejects the name %p", (name) => {
		expect(() => protoDir(name, { cwd: root, light: false })).toThrow(
			/invalid prototype name/,
		);
	});

	test("selection written in one worktree is visible from a sibling", () => {
		const main = repo();
		const a = addWorktree(main, "wt-a");
		const b = addWorktree(main, "wt-b");
		mkdirSync(durable(a, "decided"), { recursive: true });
		confirm(
			sentinelPaths(protoDir("decided", { cwd: a, light: false })),
			"VariantB",
		);
		expect(
			status(sentinelPaths(protoDir("decided", { cwd: b, light: false }))),
		).toBe("VariantB");
		expect(
			readFileSync(join(durable(a, "decided"), ".selection"), "utf8"),
		).toBe("VariantB\n");
	});
});

describe("writeSentinel", () => {
	test("publishes the whole file at once and leaves no temp file", () => {
		const dir = join(root, "atomic");
		mkdirSync(dir, { recursive: true });
		writeSentinel(join(dir, ".selection"), "B\n");
		expect(readFileSync(join(dir, ".selection"), "utf8")).toBe("B\n");
		expect(readdirSync(dir)).toEqual([".selection"]);
	});
});
