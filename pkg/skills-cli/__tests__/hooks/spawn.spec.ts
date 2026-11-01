import { describe, expect, test } from "bun:test";
import {
	OUTPUT_CAP_BYTES,
	type SpawnedProcess,
	spawnCapture,
} from "../../src/hooks/spawn";

function streamOf(...chunks: string[]) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks)
				controller.enqueue(new TextEncoder().encode(chunk));
			controller.close();
		},
	});
}

function finished(
	stdout: string[],
	stderr: string[] = [],
	status = 0,
): SpawnedProcess {
	return {
		stdout: streamOf(...stdout),
		stderr: streamOf(...stderr),
		exited: Promise.resolve(status),
		kill: () => {},
	};
}

function hanging() {
	let release: (status: number) => void = () => {};
	let resolveExit: (status: number) => void = () => {};
	const killed: string[] = [];
	const proc: SpawnedProcess = {
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				release = (status) => {
					controller.close();
					resolveExit(status);
				};
			},
		}),
		stderr: streamOf(),
		exited: new Promise<number>((resolve) => {
			resolveExit = resolve;
		}),
		kill: (signal) => {
			killed.push(signal ?? "SIGTERM");
			release(137);
		},
	};
	return { proc, killed };
}

describe("spawnCapture", () => {
	test("returns status and output of a finished command", async () => {
		const r = await spawnCapture(["x"], undefined, {
			spawn: () => finished(["out"], ["err"], 3),
		});
		expect(r).toEqual({ status: 3, stdout: "out", stderr: "err" });
	});

	test("kills a command that outlives the timeout and reports it as failed", async () => {
		const { proc, killed } = hanging();
		const r = await spawnCapture(["slow-tool"], undefined, {
			spawn: () => proc,
			timeoutMs: 20,
		});
		expect(killed).toEqual(["SIGKILL"]);
		expect(r.status).toBe(124);
		expect(r.stderr).toContain("slow-tool timed out after 20 ms");
	});

	test("truncates output past the cap and says so", async () => {
		const big = "a".repeat(100);
		const r = await spawnCapture(["x"], undefined, {
			spawn: () => finished([big, big], [big]),
			capBytes: 150,
		});
		expect(r.stdout.startsWith("a".repeat(150))).toBe(true);
		expect(r.stdout).toContain("[output truncated]");
		expect(r.stdout.replace(/\n\[output truncated\]\n$/, "")).toHaveLength(150);
		expect(r.stderr).toBe(big);
		expect(r.truncated).toBe(true);
	});

	test("leaves truncated unset when stdout fits", async () => {
		const r = await spawnCapture(["x"], undefined, {
			spawn: () => finished(["small"]),
		});
		expect(r.truncated).toBeUndefined();
	});

	test("marks stdout incomplete when reading it fails", async () => {
		const r = await spawnCapture(["x"], undefined, {
			spawn: () => ({
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("par"));
						controller.error(new Error("pipe broke"));
					},
				}),
				stderr: streamOf(),
				exited: Promise.resolve(0),
				kill: () => {},
			}),
		});
		expect(r.truncated).toBe(true);
		expect(r.stderr).toContain("x output could not be read: pipe broke");
	});

	test("returns after the timeout even when a descendant keeps the pipe open", async () => {
		const killed: string[] = [];
		const r = await spawnCapture(["parent"], undefined, {
			spawn: () => ({
				stdout: new ReadableStream<Uint8Array>({ start() {} }),
				stderr: streamOf(),
				exited: Promise.resolve(137),
				kill: (signal) => {
					killed.push(signal ?? "SIGTERM");
				},
			}),
			timeoutMs: 20,
			drainMs: 20,
		});
		expect(killed).toEqual(["SIGKILL"]);
		expect(r.status).toBe(124);
		expect(r.stderr).toContain("parent timed out after 20 ms");
	});

	test("caps each stream at 1 MiB by default", async () => {
		const chunk = "b".repeat(OUTPUT_CAP_BYTES);
		const r = await spawnCapture(["x"], undefined, {
			spawn: () => finished([chunk, chunk]),
		});
		expect(r.stdout.length).toBe(
			OUTPUT_CAP_BYTES + "\n[output truncated]\n".length,
		);
	});

	test("reports status 127 when the spawn itself throws", async () => {
		const r = await spawnCapture(["nope"], undefined, {
			spawn: () => {
				throw new Error("ENOENT: nope");
			},
		});
		expect(r).toEqual({ status: 127, stdout: "", stderr: "ENOENT: nope" });
	});
});
