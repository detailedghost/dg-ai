import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { runCapture, runCaptureBytes } from "@dg/common/node";

const SRC_DIR = resolve(import.meta.dir, "../src");
const BARREL_ENTRY = join(SRC_DIR, "index.ts");
const NODE_DIR_PREFIX = `${join(SRC_DIR, "node")}${sep}`;

function extractSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const patterns = [
		/\bfrom\s+["']([^"']+)["']/g,
		/\brequire\(\s*["']([^"']+)["']\s*\)/g,
		/\bimport\(\s*["']([^"']+)["']\s*\)/g,
		/^\s*import\s+["']([^"']+)["']\s*;?\s*$/gm,
	];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		// biome-ignore lint: exec-in-loop is the standard global-regex idiom
		while ((match = pattern.exec(source))) specifiers.push(match[1]);
	}
	return specifiers;
}

function resolveLocalSpecifier(fromFile: string, specifier: string): string {
	const base = join(dirname(fromFile), specifier);
	if (existsSync(`${base}.ts`)) return `${base}.ts`;
	if (existsSync(join(base, "index.ts"))) return join(base, "index.ts");
	return base;
}

function collectBarrelReachableFiles(): {
	files: Set<string>;
	nodeBuiltins: string[];
} {
	const visited = new Set<string>();
	const nodeBuiltins: string[] = [];
	const queue = [BARREL_ENTRY];

	while (queue.length > 0) {
		const file = queue.pop();
		if (!file || visited.has(file)) continue;
		visited.add(file);

		const source = readFileSync(file, "utf8");
		for (const specifier of extractSpecifiers(source)) {
			if (specifier.startsWith("node:")) {
				nodeBuiltins.push(`${specifier} (imported by ${file})`);
			} else if (specifier.startsWith(".")) {
				const resolved = resolveLocalSpecifier(file, specifier);
				if (!visited.has(resolved)) queue.push(resolved);
			}
		}
	}

	return { files: visited, nodeBuiltins };
}

describe("@dg/common barrel — Node-builtin isolation", () => {
	it("pulls in no node: builtin through its transitive import graph", () => {
		const { nodeBuiltins } = collectBarrelReachableFiles();
		expect(nodeBuiltins).toEqual([]);
	});

	it("never transitively reaches src/node/** from the barrel", () => {
		const { files } = collectBarrelReachableFiles();
		const leaks = [...files].filter((file) => file.startsWith(NODE_DIR_PREFIX));
		expect(leaks).toEqual([]);
	});
});

describe("runCapture", () => {
	it("distinguishes ignored stdin from the default closed pipe", async () => {
		const script = `
import { fstatSync, readFileSync } from "node:fs";
console.log(JSON.stringify({
	device: fstatSync(0).isCharacterDevice(),
	input: readFileSync(0, "utf8"),
}));
`;
		const ignored = await runCapture(process.execPath, ["-e", script], {
			stdin: null,
			timeoutMs: 2000,
		});
		const closedPipe = await runCapture(process.execPath, ["-e", script], {
			timeoutMs: 2000,
		});
		expect(ignored.status).toBe(0);
		expect(closedPipe.status).toBe(0);
		expect(JSON.parse(ignored.stdout)).toEqual({ device: true, input: "" });
		expect(JSON.parse(closedPipe.stdout)).toEqual({ device: false, input: "" });
	});

	it("preserves arbitrary bytes in both streams when buffer capture is requested", async () => {
		const stdout = Buffer.from([0xff, 0, 0x80, 32, 10]);
		const stderr = Buffer.from([0xfe, 0, 0x81, 9, 10]);
		const result = await runCaptureBytes(process.execPath, [
			"-e",
			`
await new Promise((resolve) => process.stdout.write(Buffer.from(${JSON.stringify([...stdout])}), resolve));
await new Promise((resolve) => process.stderr.write(Buffer.from(${JSON.stringify([...stderr])}), resolve));
process.exitCode = 7;
`,
		]);
		expect(result.status).toBe(7);
		expect(result.stdout).toEqual(stdout);
		expect(result.stderr).toEqual(stderr);
	});

	it("decodes UTF-8 after collecting bytes split across child writes", async () => {
		const result = await runCapture(process.execPath, [
			"-e",
			`
await new Promise((resolve) => process.stdout.write(Buffer.from([0xe2]), resolve));
await Bun.sleep(40);
process.stdout.write(Buffer.from([0x82, 0xac, 32, 10]));
`,
		]);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("€ \n");
	});

	it("keeps the child's result when it exits without reading a large stdin", () => {
		const module = join(NODE_DIR_PREFIX, "process.ts");
		const probe = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`
import { runCapture } from ${JSON.stringify(module)};
const result = await runCapture(process.execPath, ["-e", "process.exit(0)"], {stdin: "x".repeat(8 * 1024 * 1024)});
console.log(JSON.stringify({status: result.status, stdout: result.stdout, stderr: result.stderr}));
`,
			],
			{ stdout: "pipe", stderr: "pipe", timeout: 10000 },
		);
		expect(probe.stderr.toString()).toBe("");
		expect(probe.exitCode).toBe(0);
		expect(JSON.parse(probe.stdout.toString())).toEqual({
			status: 0,
			stdout: "",
			stderr: "",
		});
	});

	it("returns a non-zero status with stdout/stderr captured separately, without throwing", async () => {
		const result = await runCapture("sh", [
			"-c",
			"printf 'stdout-marker'; printf 'stderr-marker' 1>&2; exit 3",
		]);

		expect(result.status).toBe(3);
		expect(result.stdout).toContain("stdout-marker");
		expect(result.stderr).toContain("stderr-marker");
		expect(result.stdout).not.toContain("stderr-marker");
	});

	it("pipes the optional stdin option through to the child process", async () => {
		const result = await runCapture("sh", ["-c", "cat"], {
			stdin: "piped-input",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("piped-input");
	});

	it("rejects rather than resolving a fake status for a nonexistent binary", async () => {
		await expect(
			runCapture("dg-nonexistent-binary-xyz", []),
		).rejects.toBeDefined();
	});

	it("bounds a timed-out call even when a backgrounded grandchild keeps the output pipe open", async () => {
		const startedAt = Date.now();

		const result = await runCaptureBytes("sh", ["-c", "sleep 3 & sleep 10"], { timeoutMs: 100 });

		expect(Date.now() - startedAt).toBeLessThan(2000);
		expect(result.signal).toBe("SIGKILL");
	});

	it("destroys the output pipe once the grace period fires, so a lingering grandchild's later write fails instead of leaking into a nobody-reads-it pipe forever", async () => {
		const marker = join(tmpdir(), `runcapture-epipe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const scriptPath = join(tmpdir(), `runcapture-epipe-script-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
		const grandchildScript = `
process.stdout.on("error", (err) => {
	require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(err && err.code));
	process.exit(0);
});
await Bun.sleep(900);
process.stdout.write("late-data");
await Bun.sleep(200);
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "wrote-with-no-error");
`;
		writeFileSync(scriptPath, grandchildScript);
		try {
			await runCaptureBytes("sh", ["-c", `${process.execPath} ${scriptPath} & sleep 10`], {
				timeoutMs: 100,
			});

			await new Promise((resolve) => setTimeout(resolve, 1300));
			const outcome = existsSync(marker) ? readFileSync(marker, "utf8") : "never-wrote";
			expect(outcome).not.toBe("wrote-with-no-error");
		} finally {
			rmSync(marker, { force: true });
			rmSync(scriptPath, { force: true });
		}
	});
});
