import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execAllowlistLine } from "@dg/common/node";
import { checkExecAllowlist, parseExecAllowlist } from "../../src/server/exec-allowlist";

const MARKER = "fake-marker-value-for-tests";
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tool(dir: string, name = "tool.sh") {
	const path = join(dir, name);
	writeFileSync(path, "#!/bin/sh\necho ok\n");
	chmodSync(path, 0o755);
	return path;
}

function setup(lines?: (paths: { tool: string; dir: string }) => string[]) {
	const dir = mkdtempSync(join(tmpdir(), "dg-allow-"));
	dirs.push(dir);
	const path = tool(dir);
	const file = join(dir, "exec-allowlist");
	if (lines) writeFileSync(file, lines({ tool: path, dir }).join("\n"));
	return { dir, tool: path, file };
}

const check = (file: string, command: string, cwd: string, names = ["pw/live.com/owa-auth"], daemonPath?: string) =>
	checkExecAllowlist({ file, command, cwd, names, ...(daemonPath ? { daemonPath } : {}) });

describe("exec allowlist", () => {
	it("parses path, pin, glob, flag and comments", () => {
		expect(parseExecAllowlist(`# c\n/opt/x sha256=AB pw/live.com/*\nrelative/path\n/bin/sh sha256=cd allow-any-args # x\n`)).toEqual([
			{ path: "/opt/x", sha256: "ab", glob: "pw/live.com/*", allowAnyArgs: false },
			{ path: "/bin/sh", sha256: "cd", allowAnyArgs: true },
		]);
	});

	it("parses a double-quoted path with spaces and escapes, and drops a bad quote", () => {
		expect(parseExecAllowlist(`"/opt/my tools/a \\"b\\" \\\\ #c" sha256=ab pw/x/* # note\n"/opt/open sha256=ab\n"/opt/x"y sha256=ab\n`)).toEqual([
			{ path: '/opt/my tools/a "b" \\ #c', sha256: "ab", glob: "pw/x/*", allowAnyArgs: false },
		]);
	});

	it("quotes a path with spaces in the printed line, and the printed line allows it", () => {
		const { dir, file } = setup();
		const spaced = join(dir, "my tools");
		mkdirSync(spaced);
		const script = tool(spaced, 'run "it".sh');
		const line = execAllowlistLine(script);
		expect(line.startsWith(`"${spaced}/run \\"it\\".sh" sha256=`)).toBe(true);
		writeFileSync(file, `${line}\n`);
		expect(check(file, script, dir)).toMatchObject({ ok: true, path: script });
	});

	it("prints a pinned line and never writes the allowlist", () => {
		const { tool: path, file } = setup();
		const line = execAllowlistLine(path, "pw/live.com/*");
		expect(line).toMatch(new RegExp(`^${path} sha256=[0-9a-f]{64} pw/live.com/\\*$`));
		expect(require("node:fs").existsSync(file)).toBe(false);
	});

	it("refuses with a wrapper-script hint when there is no file", () => {
		const { file, tool: path, dir } = setup();
		const text = JSON.stringify(check(file, path, dir));
		expect(text).toContain('"ok":false');
		expect(text).toContain("does not exist");
		expect(text).toContain("dg-skills credentials allow");
		expect(text).not.toContain("curl");
		expect(text).not.toContain(MARKER);
	});

	it("refuses a command that is not listed, and names the file and resolved path", () => {
		const { file, tool: path, dir } = setup(() => ["/usr/bin/true"]);
		const text = JSON.stringify(check(file, path, dir));
		expect(text).toContain('"ok":false');
		expect(text).toContain(path);
		expect(text).toContain(file);
	});

	it("refuses a line with no pin", () => {
		const { file, tool: path, dir } = setup(({ tool: t }) => [t]);
		expect(check(file, path, dir)).toMatchObject({ ok: false, error: expect.stringContaining("without a sha256 pin") });
	});

	it("allows a pinned command, also through a symlink, a relative path and the daemon PATH", () => {
		const { file, tool: path, dir } = setup(({ tool: t }) => [execAllowlistLine(t, "pw/live.com/*")]);
		const link = join(dir, "link");
		symlinkSync(path, link);
		expect(check(file, path, dir)).toMatchObject({ ok: true, path });
		expect(check(file, link, dir)).toMatchObject({ ok: true, path });
		expect(check(file, "./tool.sh", dir)).toMatchObject({ ok: true, path });
		expect(check(file, "tool.sh", "/", undefined, dir)).toMatchObject({ ok: true, path });
		expect(check(file, "tool.sh", "/", undefined, "/nonexistent")).toMatchObject({ ok: false });
	});

	it("refuses after the listed file changes, and says the hash changed", () => {
		const { file, tool: path, dir } = setup(({ tool: t }) => [execAllowlistLine(t)]);
		appendFileSync(path, "echo changed\n");
		const text = JSON.stringify(check(file, path, dir));
		expect(text).toContain("sha256");
		expect(text).toContain("changed");
		expect(text).toContain(file);
	});

	it("matches * within one path segment only", () => {
		const { file, tool: path, dir } = setup(({ tool: t }) => [execAllowlistLine(t, "pw/*")]);
		expect(check(file, path, dir, ["pw/x"])).toMatchObject({ ok: true });
		expect(check(file, path, dir, ["pw/live.com/owa-auth"])).toMatchObject({ ok: false });
	});

	it("lets separate lines allow separate names in one call", () => {
		const { file, tool: path, dir } = setup(({ tool: t }) => [execAllowlistLine(t, "pw/one.test/*"), execAllowlistLine(t, "pw/two.test/*")]);
		expect(check(file, path, dir, ["pw/one.test/a", "pw/two.test/b"])).toMatchObject({ ok: true, path });
		expect(check(file, path, dir, ["pw/one.test/a", "pw/three.test/c"])).toMatchObject({ ok: false });
	});

	it.each(["sh", "curl", "git", "wget", "ssh", "find", "awk", "docker", "vim", "make"])(
		"refuses a pinned %s without allow-any-args, and allows it with the flag",
		(name) => {
			const dir = mkdtempSync(join(tmpdir(), "dg-allow-"));
			dirs.push(dir);
			const path = tool(dir, name);
			const file = join(dir, "exec-allowlist");
			writeFileSync(file, execAllowlistLine(path));
			expect(check(file, path, dir)).toMatchObject({ ok: false, error: expect.stringContaining("allow-any-args") });
			writeFileSync(file, execAllowlistLine(path, undefined, true));
			expect(check(file, path, dir)).toMatchObject({ ok: true });
		},
	);

	it("ignores a stale line when another covering line has the current pin", () => {
		const { file, tool: path, dir } = setup(({ tool: t }) => [execAllowlistLine(t)]);
		appendFileSync(path, "echo edited\n");
		appendFileSync(file, `\n${execAllowlistLine(path)}\n`);
		expect(check(file, path, dir)).toMatchObject({ ok: true, path });
	});

	it("needs a current pin for each name, not just for one of them", () => {
		const { file, tool: path, dir } = setup(({ tool: t }) => [execAllowlistLine(t, "pw/one.test/*"), execAllowlistLine(t, "pw/two.test/*")]);
		writeFileSync(file, readFileSync(file, "utf8").replace(/^(.*pw\/two\.test.*)$/m, (line) => line.replace(/sha256=[0-9a-f]+/, `sha256=${"0".repeat(64)}`)));
		expect(check(file, path, dir, ["pw/one.test/a"])).toMatchObject({ ok: true });
		expect(check(file, path, dir, ["pw/one.test/a", "pw/two.test/b"])).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
	});

	it("returns the exact bytes it hashed", () => {
		const { file, tool: path, dir } = setup(({ tool: t }) => [execAllowlistLine(t)]);
		const result = check(file, path, dir);
		expect(result.ok && Buffer.from(result.bytes).toString()).toBe(readFileSync(path, "utf8"));
	});

	it("classifies the invoked name too, so a pinned npm link needs allow-any-args", () => {
		const { dir } = setup();
		const cli = join(dir, "npm-cli.js");
		writeFileSync(cli, "#!/usr/bin/env node\nconsole.log(1)\n");
		chmodSync(cli, 0o755);
		const link = join(dir, "npm");
		symlinkSync(cli, link);
		const file = join(dir, "list");
		writeFileSync(file, execAllowlistLine(cli));
		expect(check(file, cli, dir)).toMatchObject({ ok: true });
		expect(check(file, link, dir)).toMatchObject({ ok: false, error: expect.stringContaining("allow-any-args") });
		expect(check(file, "npm", "/", undefined, dir)).toMatchObject({ ok: false, error: expect.stringContaining("allow-any-args") });
	});

	it.each([
		["#!/usr/bin/curl -K\n", false],
		["#!/usr/bin/env -S curl -K\n", false],
		["#!/bin/sh\necho ok\n", true],
		["#!/usr/bin/env python3\nprint(1)\n", true],
	])("classifies the #! line %p of a pinned script", (body, allowed) => {
		const { dir } = setup();
		const path = join(dir, "wrapper");
		writeFileSync(path, body);
		chmodSync(path, 0o755);
		const file = join(dir, "list");
		writeFileSync(file, execAllowlistLine(path));
		expect(check(file, path, dir)).toMatchObject(allowed ? { ok: true } : { ok: false, error: expect.stringContaining("allow-any-args") });
		writeFileSync(file, execAllowlistLine(path, undefined, true));
		expect(check(file, path, dir)).toMatchObject({ ok: true });
	});
});
