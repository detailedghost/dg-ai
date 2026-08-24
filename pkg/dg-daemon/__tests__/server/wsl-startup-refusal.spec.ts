import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { DgCliError, EXIT_WSL_NAT_NETWORKING } from "@dg/common";
import { isWSL, resolveDgPaths } from "@dg/common/node";
import { checkWslNetworking } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	createCleanupSlot,
	freshDgHome,
	runStart,
	spawnServe,
	stopServe,
	waitForHealth,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

describe("startup on NAT-mode WSL", () => {
	it.skipIf(!isWSL())(
		"refuses to start and names the .wslconfig networkingMode=mirrored remediation",
		async () => {
			const dgHome = freshDgHome();
			const port = allocatePort();
			const proc = spawnServe(dgHome, port, {
				DG_WSL_NETWORKING_MODE: "nat",
			});
			cleanupSlot.set(async () => cleanupDgHome(dgHome));

			const [stderr, exitCode] = await Promise.all([
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode).toBe(EXIT_WSL_NAT_NETWORKING);
			expect(stderr).toContain(".wslconfig");
			expect(stderr).toContain("networkingMode=mirrored");
		},
	);

	it.skipIf(!isWSL())(
		"starts normally when the networking-mode seam reports mirrored",
		async () => {
			const dgHome = freshDgHome();
			const port = allocatePort();
			const proc = spawnServe(dgHome, port, {
				DG_WSL_NETWORKING_MODE: "mirrored",
			});
			cleanupSlot.set(async () => {
				await stopServe(proc);
				cleanupDgHome(dgHome);
			});
			await waitForHealth(port);
		},
	);
});

describe("cmdStart refuses before the daemon ever spawns on NAT-mode WSL", () => {
	it("exits WSL-NAT, prints the mirrored-mode remediation, and creates neither a pid file nor a daemon", async () => {
		const dgHome = freshDgHome();
		const port = allocatePort();
		cleanupSlot.set(async () => cleanupDgHome(dgHome));

		const result = await runStart(dgHome, port, {
			WSL_DISTRO_NAME: "test-distro",
			DG_WSL_NETWORKING_MODE: "nat",
		});

		expect(result.exitCode).toBe(EXIT_WSL_NAT_NETWORKING);
		expect(result.stderr).toContain(".wslconfig");
		expect(result.stderr).toContain("networkingMode=mirrored");

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		expect(existsSync(paths.pidPath)).toBe(false);
		await expect(
			fetch(`http://127.0.0.1:${port}/healthz`, {
				headers: { Host: `127.0.0.1:${port}` },
				signal: AbortSignal.timeout(500),
			}),
		).rejects.toBeDefined();
	});
});

describe("checkWslNetworking with injected seams", () => {
	it("rejects with EXIT_WSL_NAT_NETWORKING and names the mirrored-mode remediation", async () => {
		try {
			await checkWslNetworking({
				isWSL: () => true,
				networkingMode: async () => "nat",
			});
			throw new Error("expected checkWslNetworking to reject");
		} catch (err) {
			expect(err).toBeInstanceOf(DgCliError);
			expect((err as DgCliError).exitCode).toBe(EXIT_WSL_NAT_NETWORKING);
			expect((err as DgCliError).message).toContain(".wslconfig");
			expect((err as DgCliError).message).toContain("networkingMode=mirrored");
		}
	});

	it("resolves to the mode without throwing when mirrored", async () => {
		const mode = await checkWslNetworking({
			isWSL: () => true,
			networkingMode: async () => "mirrored",
		});
		expect(mode).toBe("mirrored");
	});
});
