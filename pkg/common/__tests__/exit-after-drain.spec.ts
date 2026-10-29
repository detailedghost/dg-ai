import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { wait } from "../src/index";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const CHUNK = 4096;
const SLOW_MS = 2;

async function slowRead(stream: ReadableStream<Uint8Array>): Promise<number> {
	const reader = stream.getReader();
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return total;
		total += value.byteLength;
		if (total % (CHUNK * 16) < value.byteLength) await wait(SLOW_MS);
	}
}

function runChild(script: string) {
	return Bun.spawn([process.execPath, "-e", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
}

const writeThenExit = (
	stream: "stdout" | "stderr",
	bytes: number,
	code: number,
) => `
import { exitAfterDrain } from ${JSON.stringify(ENTRY)};
process.${stream}.write("x".repeat(${bytes}));
await exitAfterDrain(${code});
`;

describe("exitAfterDrain", () => {
	it("delivers every byte of a single 1.5 MiB stdout write to a slow reader", async () => {
		const bytes = 1.5 * 1024 * 1024;
		const child = runChild(writeThenExit("stdout", bytes, 0));
		const [received, exitCode] = await Promise.all([
			slowRead(child.stdout),
			child.exited,
		]);
		expect(received).toBe(bytes);
		expect(exitCode).toBe(0);
	}, 30_000);

	it("delivers every byte of a large stderr write to a slow reader", async () => {
		const bytes = 1.5 * 1024 * 1024;
		const child = runChild(writeThenExit("stderr", bytes, 0));
		const [received, exitCode] = await Promise.all([
			slowRead(child.stderr),
			child.exited,
		]);
		expect(received).toBe(bytes);
		expect(exitCode).toBe(0);
	}, 30_000);

	it("exits with the requested code after draining", async () => {
		const bytes = 256 * 1024;
		const child = runChild(writeThenExit("stdout", bytes, 3));
		const [received, exitCode] = await Promise.all([
			slowRead(child.stdout),
			child.exited,
		]);
		expect(received).toBe(bytes);
		expect(exitCode).toBe(3);
	}, 30_000);

	it("drops writes made after the drain starts", async () => {
		const bytes = 1.5 * 1024 * 1024;
		const child = runChild(`
import { exitAfterDrain } from ${JSON.stringify(ENTRY)};
process.stdout.write("x".repeat(${bytes}));
setTimeout(() => process.stdout.write("late"), 1);
await exitAfterDrain(0);
`);
		const [received, exitCode] = await Promise.all([
			slowRead(child.stdout),
			child.exited,
		]);
		expect(received).toBe(bytes);
		expect(exitCode).toBe(0);
	}, 30_000);

	it("exits with the requested code within the drain bound when the reader never reads", async () => {
		const outer = Bun.spawn(
			[
				"sh",
				"-c",
				'("$BUN" -e "$SCRIPT"; echo "exit=$?" >&2) | sleep 20',
			],
			{
				stdout: "ignore",
				stderr: "pipe",
				env: {
					...process.env,
					BUN: process.execPath,
					SCRIPT: writeThenExit("stdout", 8 * 1024 * 1024, 4),
				},
			},
		);
		const started = performance.now();
		const decoder = new TextDecoder();
		let seen = "";
		for await (const chunk of outer.stderr) {
			seen += decoder.decode(chunk);
			if (seen.includes("exit=")) break;
		}
		const elapsed = performance.now() - started;
		outer.kill();
		expect(seen).toContain("exit=4");
		expect(elapsed).toBeGreaterThanOrEqual(4_000);
		expect(elapsed).toBeLessThan(10_000);
	}, 30_000);

	it("exits promptly when nothing is pending", async () => {
		const child = runChild(writeThenExit("stdout", 0, 0));
		await expect(child.exited).resolves.toBe(0);
	});
});

const SRC_ROOT = join(import.meta.dir, "..", "..");
const EXIT_OWNER = join("common", "src", "exit.ts");
const EXIT_CALL = "process.exit(";

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			return /^(node_modules|__tests__|__test__)$/.test(entry.name)
				? []
				: sourceFiles(full);
		}
		return /\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)
			? [full]
			: [];
	});
}

describe("package sources", () => {
	it("call process.exit only from exitAfterDrain", () => {
		const offenders = readdirSync(SRC_ROOT, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) => {
				const src = join(SRC_ROOT, entry.name, "src");
				return existsSync(src) ? sourceFiles(src) : [];
			})
			.map((file) => relative(SRC_ROOT, file))
			.filter((file) => file !== EXIT_OWNER)
			.filter((file) =>
				readFileSync(join(SRC_ROOT, file), "utf8").includes(EXIT_CALL),
			);
		expect(offenders).toEqual([]);
	});
});
