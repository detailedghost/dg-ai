import { afterEach, describe, expect, it } from "bun:test";
import { OWNER_TOKEN_HEADER } from "@dg/common";
import { readOwnerToken, resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	connectCli,
	freshDgHome,
	registerSession,
	spawnServe,
	stopServe,
	waitForDaemonExit,
	waitForHealth,
} from "../utils/daemon-harness";

let dgHome = "";

afterEach(async () => {
	if (dgHome) {
		await waitForDaemonExit(dgHome).catch(() => undefined);
		cleanupDgHome(dgHome);
	}
});

describe("daemon restart", () => {
	it("reloads the stored session and the next CLI command restores cli presence", async () => {
		dgHome = freshDgHome();
		const firstPort = allocatePort();
		const first = spawnServe(dgHome, firstPort);
		await waitForHealth(firstPort);
		const bootstrap = await registerSession(firstPort, {
			agentIdentity: "claude",
			role: "orchestrator",
		});
		const attached = await connectCli(firstPort, bootstrap);
		attached.close();
		await stopServe(first);
		await waitForDaemonExit(dgHome);

		const secondPort = allocatePort();
		const second = spawnServe(dgHome, secondPort);
		try {
			await waitForHealth(secondPort);
			const owner = readOwnerToken(resolveDgPaths({ env: { DG_HOME: dgHome } }));
			expect(typeof owner).toBe("string");
			const named = await fetch(
				`http://127.0.0.1:${secondPort}/sessions/local?session=${bootstrap.sessionId}`,
				{
					headers: {
						Host: `127.0.0.1:${secondPort}`,
						[OWNER_TOKEN_HEADER]: owner ?? "",
					},
				},
			);
			const body = (await named.json()) as {
				sessions: { token?: string; agentIdentity?: string }[];
			};
			expect(body.sessions[0]?.token).toBe(bootstrap.token);

			const before = await fetch(`http://127.0.0.1:${secondPort}/sessions`, {
				headers: { Host: `127.0.0.1:${secondPort}` },
			});
			const idle = (await before.json()) as {
				sessions: { sessionId: string; presence: string; role: string }[];
			};
			expect(idle.sessions).toEqual([
				expect.objectContaining({
					sessionId: bootstrap.sessionId,
					presence: "idle",
					role: "orchestrator",
				}),
			]);

			const again = await connectCli(secondPort, bootstrap);
			again.close();
			const after = await fetch(`http://127.0.0.1:${secondPort}/sessions`, {
				headers: { Host: `127.0.0.1:${secondPort}` },
			});
			const live = (await after.json()) as {
				sessions: { presence: string }[];
			};
			expect(live.sessions[0]?.presence).toBe("cli");
		} finally {
			await stopServe(second);
		}
	});
});
