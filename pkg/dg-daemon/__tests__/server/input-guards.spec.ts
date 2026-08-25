/** Pure guards over operator- and caller-supplied input: loopback authority, DG_PORT, WSL mode, executable denylist. */

import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_DEFAULT_PORT, CHAT_PORT_FALLBACK_COUNT } from "@dg/common";
import { checkExecutable, checkWslNetworking } from "@dg/common/node";
import { isLoopbackHost } from "../../src/server/host-guard";
import { candidatePorts } from "../../src/server/ports";

describe("isLoopbackHost", () => {
	it("accepts every loopback authority form the daemon can be reached on", () => {
		expect(isLoopbackHost("127.0.0.1:47500", 47500)).toBe(true);
		expect(isLoopbackHost("localhost:47500", 47500)).toBe(true);
		expect(isLoopbackHost("[::1]:47500", 47500)).toBe(true);
		expect(isLoopbackHost("[::1]:47500".toUpperCase(), 47500)).toBe(true);
	});

	it("refuses a non-loopback authority and a loopback host on the wrong port", () => {
		expect(isLoopbackHost("attacker.example:47500", 47500)).toBe(false);
		expect(isLoopbackHost("127.0.0.1:47501", 47500)).toBe(false);
		expect(isLoopbackHost("[::1]:47501", 47500)).toBe(false);
		expect(isLoopbackHost(null, 47500)).toBe(false);
	});
});

describe("candidatePorts", () => {
	const original = process.env.DG_PORT;

	afterEach(() => {
		if (original === undefined) delete process.env.DG_PORT;
		else process.env.DG_PORT = original;
	});

	it("returns the deterministic fallback range when DG_PORT is unset", () => {
		delete process.env.DG_PORT;

		expect(candidatePorts()).toEqual(
			Array.from(
				{ length: CHAT_PORT_FALLBACK_COUNT + 1 },
				(_, i) => CHAT_DEFAULT_PORT + i,
			),
		);
	});

	it("honours a valid pinned DG_PORT", () => {
		process.env.DG_PORT = "51000";

		expect(candidatePorts()).toEqual([51000]);
	});

	it.each([
		["not-a-number", "text"],
		["0", "zero"],
		["-1", "negative"],
		["65536", "above the TCP range"],
		["47500.5", "fractional"],
	])("refuses DG_PORT=%s (%s) instead of binding it", (value) => {
		process.env.DG_PORT = value;

		expect(() => candidatePorts()).toThrow(/DG_PORT must be an integer/);
	});
});

describe("checkWslNetworking", () => {
	it("refuses an unrecognized DG_WSL_NETWORKING_MODE rather than trusting the cast", async () => {
		const attempt = checkWslNetworking({
			isWSL: () => true,
			env: { DG_WSL_NETWORKING_MODE: "bridged" },
		});

		await expect(attempt).rejects.toThrow(
			/DG_WSL_NETWORKING_MODE must be one of/,
		);
	});

	it("accepts the three ratified modes, casing and padding included", async () => {
		expect(
			await checkWslNetworking({
				isWSL: () => true,
				env: { DG_WSL_NETWORKING_MODE: " Mirrored " },
			}),
		).toBe("mirrored");
		expect(
			await checkWslNetworking({
				isWSL: () => true,
				env: { DG_WSL_NETWORKING_MODE: "unknown" },
			}),
		).toBe("unknown");
	});

	it("still refuses to start in nat mode", async () => {
		const attempt = checkWslNetworking({
			isWSL: () => true,
			env: { DG_WSL_NETWORKING_MODE: "nat" },
		});

		await expect(attempt).rejects.toThrow(/NAT networking mode/);
	});
});

describe("checkExecutable denylist", () => {
	it.each([
		"php",
		"lua",
		"deno",
		"awk",
		"xargs",
		"socat",
		"nohup",
		"expect",
	])("refuses %s, which can evaluate a caller-supplied program", (name) => {
		expect(checkExecutable(name)).toMatch(
			/forbidden shell or script host|does not resolve on PATH/,
		);
	});

	it("still admits an ordinary non-interpreter binary", () => {
		expect(checkExecutable("echo")).toBeUndefined();
	});
});
