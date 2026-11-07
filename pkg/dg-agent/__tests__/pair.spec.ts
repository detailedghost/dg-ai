import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHAT_PAIR_OFFER_PATH,
	type PairOffer,
	type PairOfferStatus,
	validatePairOffer,
	validatePairOfferStatus,
} from "@dg/common";
import { ownerTokenPath, resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	EXTENSION_ORIGIN,
	freshDgHome,
	killDaemonByPidFile,
	registerSession,
	sessionCredentials,
	spawnServe,
	waitForDaemonExit,
	waitForHealth,
} from "@dg/dg-daemon/test-harness";
import { runCli } from "./cli-wire";

const USAGE = "pair takes a 6 digit code from the extension popup.";

let dgHome: string;
const scratchDirs: string[] = [];

afterEach(async () => {
	killDaemonByPidFile(dgHome);
	await waitForDaemonExit(dgHome).catch(() => {});
	cleanupDgHome(dgHome);
	for (const dir of scratchDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function boot() {
	dgHome = freshDgHome();
	const port = allocatePort();
	spawnServe(dgHome, port);
	await waitForHealth(port);
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "dg-pair-cwd-")));
	scratchDirs.push(cwd);
	return { port, cwd };
}

async function createOffer(port: number): Promise<PairOffer> {
	const response = await fetch(`http://127.0.0.1:${port}${CHAT_PAIR_OFFER_PATH}`, {
		method: "POST",
		headers: { Host: `127.0.0.1:${port}`, Origin: EXTENSION_ORIGIN },
	});
	expect(response.status).toBe(201);
	return validatePairOffer(await response.json());
}

async function pollOffer(port: number, offerId: string): Promise<PairOfferStatus> {
	const response = await fetch(
		`http://127.0.0.1:${port}${CHAT_PAIR_OFFER_PATH}/${offerId}`,
		{ headers: { Host: `127.0.0.1:${port}`, Origin: EXTENSION_ORIGIN } },
	);
	expect(response.status).toBe(200);
	return validatePairOfferStatus(await response.json());
}

function wrongCode(code: string): string {
	return `${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`;
}

describe("dg-agent pair", () => {
	it("claims the offer with the cwd session, prints the Paired line, and the poll carries that session's bootstrap", async () => {
		const { port, cwd } = await boot();
		const session = await registerSession(port, { cwd, agentIdentity: "claude" });
		const credentials = await sessionCredentials(dgHome, session.sessionId);
		const offer = await createOffer(port);

		const result = await runCli(dgHome, port, ["pair", offer.code], {}, { cwd });

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(
			`Paired claude (${session.sessionId.slice(0, 8)}) with the browser extension.`,
		);
		expect(result.stderr).not.toContain(offer.code);
		expect(result.stdout).not.toContain(credentials.token);
		expect(await pollOffer(port, offer.offerId)).toEqual({
			status: "claimed",
			bootstrap: {
				port,
				sessionId: session.sessionId,
				token: credentials.token,
				agentIdentity: "claude",
			},
		});
	});

	it("prints the multi-match message and exits 1 when two sessions share the cwd", async () => {
		const { port, cwd } = await boot();
		const first = await registerSession(port, { cwd });
		const second = await registerSession(port, { cwd });
		const offer = await createOffer(port);

		const result = await runCli(dgHome, port, ["pair", offer.code], {}, { cwd });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("found 2 matches");
		expect(result.stderr).toContain("--session <id>");
		expect(result.stderr).toContain(first.sessionId);
		expect(result.stderr).toContain(second.sessionId);
		expect((await pollOffer(port, offer.offerId)).status).toBe("pending");
	});

	it.each([["-s"], ["--session"]])(
		"selects the named session with %s",
		async (flag) => {
			const { port, cwd } = await boot();
			await registerSession(port, { cwd, agentIdentity: "first" });
			const second = await registerSession(port, { cwd, agentIdentity: "second" });
			const offer = await createOffer(port);

			const result = await runCli(
				dgHome,
				port,
				["pair", offer.code, flag, second.sessionId],
				{},
				{ cwd },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(second.sessionId.slice(0, 8));
			const status = await pollOffer(port, offer.offerId);
			if (status.status !== "claimed") throw new Error("offer not claimed");
			expect(status.bootstrap.sessionId).toBe(second.sessionId);
		},
	);

	it.each([["12345"], ["1234567"], ["abcdef"], ["12 456"]])(
		"rejects the code %p with the usage text before any daemon call",
		async (code) => {
			dgHome = freshDgHome();

			const result = await runCli(dgHome, allocatePort(), ["pair", code]);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(USAGE);
			expect(result.stdout).toBe("");
		},
	);

	it("prints the daemon's text for a wrong code and exits 1", async () => {
		const { port, cwd } = await boot();
		await registerSession(port, { cwd });
		const offer = await createOffer(port);

		const result = await runCli(
			dgHome,
			port,
			["pair", wrongCode(offer.code)],
			{},
			{ cwd },
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"no pairing offer matches this code; open the extension popup and read the code again",
		);
	});

	it("prints the daemon's text for an expired offer and exits 1", async () => {
		const { port, cwd } = await boot();
		await registerSession(port, { cwd });
		const stale = await createOffer(port);
		await createOffer(port);

		const result = await runCli(dgHome, port, ["pair", stale.code], {}, { cwd });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"pairing offer expired; open the extension popup for a new code",
		);
	});

	it("prints the lockout text after five wrong codes and exits 1", async () => {
		const { port, cwd } = await boot();
		await registerSession(port, { cwd });
		const offer = await createOffer(port);
		for (let attempt = 0; attempt < 5; attempt++) {
			await runCli(dgHome, port, ["pair", wrongCode(offer.code)], {}, { cwd });
		}

		const result = await runCli(dgHome, port, ["pair", offer.code], {}, { cwd });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"too many wrong pairing codes; reopen the extension popup for a new code",
		);
	});

	it("prints the no-session message and changes no offer state when the owner token is missing", async () => {
		const { port, cwd } = await boot();
		await registerSession(port, { cwd });
		const offer = await createOffer(port);
		rmSync(ownerTokenPath(resolveDgPaths({ env: { DG_HOME: dgHome } })));

		const result = await runCli(dgHome, port, ["pair", offer.code], {}, { cwd });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("found 0 matches");
		expect((await pollOffer(port, offer.offerId)).status).toBe("pending");
	});
});
