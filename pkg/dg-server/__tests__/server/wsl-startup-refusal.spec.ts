/**
 * "Refuse to start on WSL in NAT networking mode, naming the .wslconfig
 * networkingMode=mirrored fix." checkWslNetworking() only consults
 * DG_WSL_NETWORKING_MODE after its own real isWSL() check passes (cmdServe()
 * calls it with no seams) — so this only exercises for real on a genuinely-WSL
 * box. Environment guard, not a placeholder: mirrors loopback-and-health.spec.ts's
 * it.skipIf(!externalIp) — runs for real here (confirmed via /proc/version) and
 * on any WSL-hosted CI runner, skips elsewhere rather than asserting nothing.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { isWSL, resolveDgPaths } from "@dg/common/node";
import { DgCliError, EXIT_WSL_NAT_NETWORKING } from "../../src/server/errors";
import { checkWslNetworking } from "../../src/server/wsl-guard";
import {
	allocatePort,
	cleanupDgHome,
	freshDgHome,
	runStart,
	spawnServe,
	stopServe,
	waitForHealth,
} from "../utils/daemon-harness";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

describe("startup on NAT-mode WSL", () => {
	it.skipIf(!isWSL())(
		"refuses to start and names the .wslconfig networkingMode=mirrored remediation",
		async () => {
			const dgHome = freshDgHome();
			const port = allocatePort();
			const proc = spawnServe(dgHome, port, {
				DG_WSL_NETWORKING_MODE: "nat",
			});
			cleanup = async () => cleanupDgHome(dgHome);

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
			cleanup = async () => {
				await stopServe(proc);
				cleanupDgHome(dgHome);
			};
			await waitForHealth(port); // would time out if the refusal path fired instead
		},
	);
});

/**
 * `spawnServe`'s child is detached with stdio ignored, so only cmdStart's own
 * foregrounded call ever surfaces the refusal. WSL_DISTRO_NAME forces isWSL()
 * true, so this runs portably rather than gated to a real WSL box.
 */
describe("cmdStart refuses before the daemon ever spawns on NAT-mode WSL", () => {
	it("exits WSL-NAT, prints the mirrored-mode remediation, and creates neither a lockfile nor a daemon", async () => {
		const dgHome = freshDgHome();
		const port = allocatePort();
		cleanup = async () => cleanupDgHome(dgHome);

		const result = await runStart(dgHome, port, {
			WSL_DISTRO_NAME: "test-distro",
			DG_WSL_NETWORKING_MODE: "nat",
		});

		expect(result.exitCode).toBe(EXIT_WSL_NAT_NETWORKING);
		expect(result.stderr).toContain(".wslconfig");
		expect(result.stderr).toContain("networkingMode=mirrored");

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		expect(existsSync(paths.lockfilePath)).toBe(false);
		await expect(
			fetch(`http://127.0.0.1:${port}/health`, {
				headers: { Host: `127.0.0.1:${port}` },
				signal: AbortSignal.timeout(500),
			}),
		).rejects.toBeDefined();
	});
});

// Injects WslGuardSeams so the NAT-refusal branch is verifiable off real WSL.
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
