import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { scratchFixtures } from "./git-repo-fixtures";

const fixtures = scratchFixtures();
afterEach(() => fixtures.cleanup());

const CLI = `${import.meta.dir}/../src/index.ts`;
// Synthetic PNG signature plus non-text bytes: no real clipboard content is used.
const PNG = Buffer.alloc(256 * 1024, 0x80);
PNG.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 1]);
const nativeScript = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.CLIPBOARD_TEST_LOG, JSON.stringify({ tool, args }) + "\\n");
if (tool === "wslpath") {
  process.stdout.write(args.at(-1) + "\\n");
} else {
  if (process.env.CLIPBOARD_TEST_EMPTY !== "1") {
    const bytes = readFileSync(process.env.CLIPBOARD_TEST_PNG);
    if (tool === "powershell.exe") {
      const destination = args.at(-1).match(/\\.Save\\('([^']+)'/)[1];
      writeFileSync(destination, bytes);
    } else await new Promise((resolve, reject) => process.stdout.write(bytes, (error) => error ? reject(error) : resolve()));
  }
  process.stderr.write("native diagnostic should remain suppressed\\n");
  process.exit(Number(process.env.CLIPBOARD_TEST_STATUS ?? 0));
}
`;

function clipboardFixture(
	tools: string[] = ["wl-paste", "xclip", "powershell.exe", "wslpath"],
) {
	const root = fixtures.tmp("dg-clipboard-");
	const cwd = join(root, "cwd");
	const bin = join(root, "bin");
	const temp = join(root, "temp");
	const home = join(root, "home");
	for (const dir of [cwd, bin, temp, home]) mkdirSync(dir);
	for (const tool of tools)
		writeFileSync(join(bin, tool), nativeScript, { mode: 0o755 });
	const log = join(root, "native.jsonl");
	const payload = join(root, "synthetic.png");
	writeFileSync(payload, PNG);
	const preload = join(root, "platform-preload.ts");
	// Only the kernel probe is synthetic. All file IO and actual CLI dispatch remain real.
	writeFileSync(
		preload,
		`
import { mock } from "bun:test";
const fs = await import("node:fs");
const readFile = fs.readFileSync;
mock.module("node:fs", () => ({ ...fs, readFileSync: (path, ...options) => {
  if (String(path) === "/proc/version") {
    const version = "Linux test kernel";
    return options[0] === "utf8" ? version : Buffer.from(version);
  }
  return readFile(path, ...options);
} }));
`,
	);
	const env = {
		...process.env,
		HOME: home,
		TMPDIR: temp,
		TMP: temp,
		TEMP: temp,
		PATH: bin,
		PLATFORM_IS_WSL: "0",
		WSL_DISTRO_NAME: "",
		WSL_INTEROP: "",
		WAYLAND_DISPLAY: "test-wayland",
		DISPLAY: ":99",
		CLIPBOARD_TEST_LOG: log,
		CLIPBOARD_TEST_PNG: payload,
		CLIPBOARD_TEST_EMPTY: "0",
		CLIPBOARD_TEST_STATUS: "0",
	};
	return {
		cwd,
		temp,
		env,
		run(args: string[] = [], overrides: Record<string, string> = {}) {
			return Bun.spawnSync(
				[
					process.execPath,
					"run",
					"--preload",
					preload,
					CLI,
					"clipboard-image",
					...args,
				],
				{
					cwd,
					env: { ...env, ...overrides },
				},
			);
		},
		calls(): { tool: string; args: string[] }[] {
			return existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [];
		},
	};
}

describe("clipboard-image output", () => {
	test("writes the exact binary bytes to stdout for '-' and removes its temporary file", () => {
		const f = clipboardFixture();
		const proc = f.run(["-"]);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.length).toBe(PNG.length);
		expect(proc.stdout.equals(PNG)).toBe(true);
		expect(proc.stderr.toString()).toBe("");
		expect(readdirSync(f.temp)).toEqual([]);
		expect(existsSync(join(f.cwd, ".agents"))).toBe(false);
	});

	test("defaults to a relative timestamped .agents/clipboard PNG", () => {
		const f = clipboardFixture();
		const proc = f.run();
		expect(proc.exitCode).toBe(0);
		expect(proc.stderr.toString()).toBe("");
		const destination = proc.stdout.toString().trim();
		expect(isAbsolute(destination)).toBe(false);
		expect(dirname(destination)).toBe(".agents/clipboard");
		expect(basename(destination)).toMatch(/^clipboard-\d{8}-\d{6}\.png$/);
		expect(readFileSync(join(f.cwd, destination)).equals(PNG)).toBe(true);
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test("overwrites an explicit relative destination and prints that exact argument", () => {
		const f = clipboardFixture();
		writeFileSync(join(f.cwd, "photo.png"), "old content");
		const proc = f.run(["photo.png"]);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("photo.png\n");
		expect(proc.stderr.toString()).toBe("");
		expect(readFileSync(join(f.cwd, "photo.png")).equals(PNG)).toBe(true);
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test("supports an absolute destination containing spaces and ignores extra arguments", () => {
		const f = clipboardFixture();
		const destination = join(f.cwd, "my photo.png");
		const proc = f.run([destination, "ignored", "--also-ignored"]);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe(`${destination}\n`);
		expect(readFileSync(destination).equals(PNG)).toBe(true);
		expect(proc.stderr.toString()).toBe("");
	});

	test("replaces a destination symlink while preserving its referent", () => {
		const f = clipboardFixture();
		const referent = join(f.cwd, "original.txt");
		const destination = join(f.cwd, "photo.png");
		writeFileSync(referent, "original contents");
		symlinkSync(referent, destination);
		const proc = f.run(["photo.png"]);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("photo.png\n");
		expect(proc.stderr.toString()).toBe("");
		expect(lstatSync(destination).isSymbolicLink()).toBe(false);
		expect(readFileSync(destination).equals(PNG)).toBe(true);
		expect(readFileSync(referent, "utf8")).toBe("original contents");
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test("moves the captured PNG into an existing destination directory", () => {
		const f = clipboardFixture();
		const destination = join(f.cwd, "photos");
		mkdirSync(destination);
		const proc = f.run(["photos"]);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("photos\n");
		expect(proc.stderr.toString()).toBe("");
		const files = readdirSync(destination);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^clipboard-image-.+\.png$/);
		expect(readFileSync(join(destination, files[0])).equals(PNG)).toBe(true);
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test("replaces an existing file with the capture's private mode", () => {
		const f = clipboardFixture();
		const destination = join(f.cwd, "photo.png");
		writeFileSync(destination, "old content", { mode: 0o644 });
		const proc = f.run(["photo.png"]);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("photo.png\n");
		expect(proc.stderr.toString()).toBe("");
		expect(readFileSync(destination).equals(PNG)).toBe(true);
		expect(statSync(destination).mode & 0o777).toBe(0o600);
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test.each(["--scratch", "-s"])(
		"retains a readable temporary PNG for %s",
		(flag) => {
			const f = clipboardFixture();
			const proc = f.run([flag]);
			expect(proc.exitCode).toBe(0);
			expect(proc.stderr.toString()).toBe("");
			const destination = proc.stdout.toString().trim();
			expect(isAbsolute(destination)).toBe(true);
			expect(basename(destination)).toMatch(/^clipboard-image-.+\.png$/);
			expect(readFileSync(destination).equals(PNG)).toBe(true);
			expect(dirname(destination)).toBe(f.temp);
			expect(readdirSync(f.temp)).toEqual([basename(destination)]);
		},
	);
});

describe("clipboard-image backend selection", () => {
	test.each(["PLATFORM_IS_WSL", "WSL_DISTRO_NAME", "WSL_INTEROP"])(
		"prioritizes Windows clipboard when %s indicates WSL",
		(variable) => {
			const f = clipboardFixture();
			const proc = f.run(["-"], {
				[variable]: variable === "PLATFORM_IS_WSL" ? "1" : "test-wsl",
			});
			expect(proc.exitCode).toBe(0);
			expect(proc.stdout.length).toBe(PNG.length);
			expect(proc.stdout.equals(PNG)).toBe(true);
			expect(proc.stderr.toString()).toBe("");
			const calls = f.calls();
			expect(calls.map((call) => call.tool)).toEqual([
				"wslpath",
				"powershell.exe",
			]);
			expect(calls[0].args[0]).toBe("-w");
			expect(calls[1].args).toEqual(
				expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
			);
			expect(calls[1].args.at(-1)).toContain(
				"[System.Windows.Forms.Clipboard]::GetImage()",
			);
			expect(readdirSync(f.temp)).toEqual([]);
		},
	);

	test("prefers Wayland over X11 when both displays and tools exist", () => {
		const f = clipboardFixture();
		expect(f.run(["-"]).exitCode).toBe(0);
		expect(f.calls()).toEqual([
			{ tool: "wl-paste", args: ["--type", "image/png"] },
		]);
	});

	test("falls back to X11 when wl-paste is unavailable", () => {
		const f = clipboardFixture(["xclip"]);
		const proc = f.run(["-"]);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.length).toBe(PNG.length);
		expect(proc.stdout.equals(PNG)).toBe(true);
		expect(f.calls()).toEqual([
			{
				tool: "xclip",
				args: ["-selection", "clipboard", "-t", "image/png", "-o"],
			},
		]);
	});

	test("uses X11 when Wayland display is absent", () => {
		const f = clipboardFixture();
		expect(f.run(["-"], { WAYLAND_DISPLAY: "" }).exitCode).toBe(0);
		expect(f.calls()[0].tool).toBe("xclip");
	});
});

describe("clipboard-image failures and help", () => {
	test("reports every backend installation hint and removes its temporary file", () => {
		const f = clipboardFixture([]);
		const proc = f.run(["-"]);
		expect(proc.exitCode).toBe(1);
		expect(proc.stdout.length).toBe(0);
		expect(proc.stderr.toString()).toBe(
			"clipboard-image: no supported clipboard backend found\n  Wayland: install wl-paste (wl-clipboard)\n  X11:     install xclip\n  WSL:     run inside WSL\n",
		);
		expect(f.calls()).toEqual([]);
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test("reports no image before validating an unknown output flag", () => {
		const f = clipboardFixture();
		const proc = f.run(["--unknown"], {
			CLIPBOARD_TEST_EMPTY: "1",
			CLIPBOARD_TEST_STATUS: "1",
		});
		expect(proc.exitCode).toBe(1);
		expect(proc.stdout.length).toBe(0);
		expect(proc.stderr.toString()).toBe(
			"clipboard-image: no image on clipboard\n",
		);
		expect(f.calls().map((call) => call.tool)).toEqual(["wl-paste"]);
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test("names the missing native command before reporting no image", () => {
		const f = clipboardFixture(["wslpath"]);
		const proc = f.run(["-"], { PLATFORM_IS_WSL: "1" });
		expect(proc.exitCode).toBe(1);
		expect(proc.stderr.toString()).toMatch(
			/^clipboard-image: .*powershell\.exe.*\nclipboard-image: no image on clipboard\n$/,
		);
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test("validates an unknown flag after successful extraction and cleans up", () => {
		const f = clipboardFixture();
		const proc = f.run(["--unknown"]);
		expect(proc.exitCode).toBe(1);
		expect(proc.stdout.length).toBe(0);
		expect(proc.stderr.toString()).toBe(
			"clipboard-image: unknown flag: --unknown\n",
		);
		expect(f.calls().map((call) => call.tool)).toEqual(["wl-paste"]);
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test("does not fall back to Linux clipboard after an empty Windows clipboard", () => {
		const f = clipboardFixture();
		const proc = f.run(["-"], {
			PLATFORM_IS_WSL: "1",
			CLIPBOARD_TEST_EMPTY: "1",
			CLIPBOARD_TEST_STATUS: "1",
		});
		expect(proc.exitCode).toBe(1);
		expect(proc.stdout.length).toBe(0);
		expect(proc.stderr.toString()).toBe(
			"clipboard-image: no image on clipboard\n",
		);
		expect(f.calls().map((call) => call.tool)).toEqual([
			"wslpath",
			"powershell.exe",
		]);
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test("retains legacy nonempty-output behavior when the native tool exits nonzero", () => {
		const f = clipboardFixture();
		const proc = f.run(["-"], { CLIPBOARD_TEST_STATUS: "1" });
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.length).toBe(PNG.length);
		expect(proc.stdout.equals(PNG)).toBe(true);
		expect(proc.stderr.toString()).toBe("");
	});

	test("cleans up when the explicit destination's parent does not exist", () => {
		const f = clipboardFixture();
		const proc = f.run(["missing/photo.png"]);
		expect(proc.exitCode).toBe(1);
		expect(proc.stdout.length).toBe(0);
		expect(proc.stderr.length).toBeGreaterThan(0);
		expect(f.calls().map((call) => call.tool)).toEqual(["wl-paste"]);
		expect(existsSync(join(f.cwd, "missing"))).toBe(false);
		expect(readdirSync(f.temp)).toEqual([]);
	});

	test.each(["--help", "-h"])(
		"prints additive help for %s without invoking native tools or creating output",
		(flag) => {
			const f = clipboardFixture();
			const proc = f.run([flag]);
			expect(proc.exitCode).toBe(0);
			expect(proc.stdout.toString()).toContain("clipboard-image");
			expect(proc.stdout.toString()).toContain("--scratch");
			expect(proc.stderr.toString()).toBe("");
			expect(f.calls()).toEqual([]);
			expect(readdirSync(f.temp)).toEqual([]);
			expect(existsSync(join(f.cwd, ".agents"))).toBe(false);
		},
	);
});
