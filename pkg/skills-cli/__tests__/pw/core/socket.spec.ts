import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import type net from "node:net";
import path from "node:path";
import {
	call,
	type DaemonRequest,
	type DaemonResponse,
	serve,
} from "../../../src/pw/core/socket";
import { useTempScratch } from "../../../src/pw/test-support";

const scratch = useTempScratch();
let server: net.Server | undefined;

afterEach(() => {
	server?.close();
	server = undefined;
});

const socketPath = () => path.join(scratch.dir, "t.sock");

describe("socket", () => {
	test("round-trips one request per connection", async () => {
		const seen: DaemonRequest[] = [];
		server = await serve(socketPath(), async (request) => {
			seen.push(request);
			return { id: request.id, result: { text: "hi", exitCode: 0 } };
		});
		const request: DaemonRequest = {
			id: "1",
			method: "run",
			params: { argv: ["goto", "x"], cwd: "/w", raw: false },
		};
		expect(await call({ socketPath: socketPath() }, request)).toEqual({
			id: "1",
			result: { text: "hi", exitCode: 0 },
		});
		expect(
			await call({ socketPath: socketPath() }, { id: "2", method: "ping" }),
		).toMatchObject({ id: "2" });
		expect(seen.map((r) => r.id)).toEqual(["1", "2"]);
	});

	test("answers a malformed request with an error response", async () => {
		server = await serve(socketPath(), async () => ({
			id: "x",
			result: { text: "", exitCode: 0 },
		}));
		const text = await new Promise<string>((resolve) => {
			const client = Bun.connect({
				unix: socketPath(),
				socket: {
					open: (s) => void s.write("not json\n"),
					data: (_s, d) => resolve(d.toString()),
				},
			});
			void client;
		});
		expect(JSON.parse(text)).toMatchObject({ error: expect.any(String) });
	});

	test("rejects when nobody listens", async () => {
		await expect(
			call({ socketPath: socketPath() }, { id: "1", method: "ping" }),
		).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("rejects when the daemon takes longer than the timeout", async () => {
		server = await serve(
			socketPath(),
			() => new Promise<DaemonResponse>(() => undefined),
		);
		await expect(
			call({ socketPath: socketPath() }, { id: "1", method: "ping" }, 100),
		).rejects.toThrow("Timed out");
	});

	test("replaces a stale socket file left by a crashed daemon", async () => {
		await Bun.write(socketPath(), "");
		server = await serve(socketPath(), async (request) => ({
			id: request.id,
			result: { text: "up", exitCode: 0 },
		}));
		expect(
			await call({ socketPath: socketPath() }, { id: "1", method: "ping" }),
		).toMatchObject({
			result: { text: "up" },
		});
	});
});

describe("socket permissions", () => {
	test("serves on a socket only the owner can use", async () => {
		server = await serve(socketPath(), async (request) => ({
			id: request.id,
			result: { text: "", exitCode: 0 },
		}));
		expect(statSync(socketPath()).mode & 0o777).toBe(0o600);
	});
});
