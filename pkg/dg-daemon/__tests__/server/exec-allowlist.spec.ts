import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExecAllowlist, parseExecAllowlist } from "../../src/server/exec-allowlist";

const MARKER = "fake-marker-value-for-tests";
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(lines?: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "dg-allow-"));
	dirs.push(dir);
	const tool = join(dir, "tool.sh");
	writeFileSync(tool, "#!/bin/sh\necho ok\n");
	chmodSync(tool, 0o755);
	const file = join(dir, "exec-allowlist");
	if (lines) writeFileSync(file, lines.map((line) => line.replace("$TOOL", tool)).join("\n"));
	return { dir, tool, file };
}

const check = (file: string, command: string, cwd: string, names = ["pw/live.com/owa-auth"], daemonPath?: string) =>
	checkExecAllowlist({ file, command, cwd, names, ...(daemonPath ? { daemonPath } : {}) });

describe("exec allowlist", () => {
	it("parses entries, globs, flags and comments", () => {
		expect(parseExecAllowlist("# c\n/usr/bin/curl pw/live.com/*\nrelative/path\n/bin/sh allow-interpreter # x\n")).toEqual([
			{ path: "/usr/bin/curl", glob: "pw/live.com/*", allowInterpreter: false },
			{ path: "/bin/sh", allowInterpreter: true },
		]);
	});

	it("refuses with a hint when there is no file", () => {
		const { file, tool, dir } = setup();
		const text = JSON.stringify(check(file, tool, dir));
		expect(text).toContain('"ok":false');
		expect(text).toContain("does not exist");
		expect(text).toContain(file);
		expect(text).not.toContain(MARKER);
	});

	it("refuses a command that is not listed, and names the file and resolved path", () => {
		const { file, tool, dir } = setup(["/usr/bin/true"]);
		const text = JSON.stringify(check(file, tool, dir));
		expect(text).toContain('"ok":false');
		expect(text).toContain(tool);
		expect(text).toContain(file);
	});

	it("allows a listed command, also through a symlink and a relative path", () => {
		const { file, tool, dir } = setup(["$TOOL pw/live.com/*"]);
		const link = join(dir, "link");
		symlinkSync(tool, link);
		expect(check(file, tool, dir)).toEqual({ ok: true, path: tool });
		expect(check(file, link, dir)).toEqual({ ok: true, path: tool });
		expect(check(file, "./tool.sh", dir)).toEqual({ ok: true, path: tool });
	});

	it("resolves a bare name through the daemon PATH only", () => {
		const { file, tool, dir } = setup(["$TOOL"]);
		expect(check(file, "tool.sh", "/", undefined, dir)).toEqual({ ok: true, path: tool });
		expect(check(file, "tool.sh", "/", undefined, "/nonexistent")).toMatchObject({ ok: false });
	});

	it("refuses a name outside the entry glob", () => {
		const { file, tool, dir } = setup(["$TOOL pw/live.com/*"]);
		expect(check(file, tool, dir, ["pw/example.com/key"])).toMatchObject({ ok: false });
	});

	it("refuses a shell even when listed, unless the entry allows interpreters", () => {
		const shell = Bun.which("sh") as string;
		const listed = setup([shell]);
		expect(check(listed.file, "sh", listed.dir)).toMatchObject({ ok: false, error: expect.stringContaining("shell or interpreter") });
		const opted = setup([`${shell} allow-interpreter`]);
		expect(check(opted.file, "sh", opted.dir)).toMatchObject({ ok: true });
	});
});
