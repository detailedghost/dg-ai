import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
	CHAT_PAIR_CLAIM_PATH,
	CHAT_PAIR_OFFER_PATH,
	OWNER_TOKEN_HEADER,
	PAIR_CODE_PATTERN,
	type PairOffer,
	validatePairOffer,
	validatePairOfferStatus,
} from "@dg/common";
import { readOwnerToken, resolveDgPaths } from "@dg/common/node";
import { PAIRING_TTL_MS } from "../../src/pairing";
import { writeConfig } from "../../src/server/config-store";
import {
	allocatePort,
	BROWSER_ORIGIN,
	cleanupDgHome,
	createCleanupSlot,
	EXTENSION_ORIGIN,
	freshDgHome,
	readDaemonLog,
	registerSession,
	removeScratchDirs,
	runDaemonCommand,
	sessionCredentials,
	spawnServe,
	stopServe,
	waitForDaemonExit,
	waitForHealth,
} from "../utils/daemon-harness";

const OTHER_EXTENSION_ORIGIN =
	"chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MISSING_OFFER_TEXT =
	"no pairing offer matches this code; open the extension popup and read the code again";
const LOCKED_TEXT =
	"too many wrong pairing codes; reopen the extension popup for a new code";
const FULL_TEXT = "too many pairing offers; wait for one to expire";

afterEach(removeScratchDirs);

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function bootDaemon() {
	const dgHome = freshDgHome();
	const port = allocatePort();
	let proc = spawnServe(dgHome, port);
	await waitForHealth(port);
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	return {
		dgHome,
		port,
		paths,
		ownerToken: readOwnerToken(paths) as string,
		async restart() {
			await stopServe(proc);
			await waitForDaemonExit(dgHome);
			proc = spawnServe(dgHome, port);
			await waitForHealth(port);
		},
	};
}

type Daemon = Awaited<ReturnType<typeof bootDaemon>>;

function url(port: number, path: string): string {
	return `http://127.0.0.1:${port}${path}`;
}

function offerRequest(
	port: number,
	origin: string | null = EXTENSION_ORIGIN,
): Promise<Response> {
	return fetch(url(port, CHAT_PAIR_OFFER_PATH), {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			...(origin === null ? {} : { Origin: origin }),
		},
	});
}

function statusRequest(
	port: number,
	offerId: string,
	origin: string | null = EXTENSION_ORIGIN,
): Promise<Response> {
	return fetch(url(port, `${CHAT_PAIR_OFFER_PATH}/${offerId}`), {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			...(origin === null ? {} : { Origin: origin }),
		},
	});
}

function claimRequest(
	daemon: Daemon,
	body: unknown,
	options: {
		owner?: string | null;
		origin?: string;
		contentType?: string | null;
	} = {},
): Promise<Response> {
	const owner = options.owner === undefined ? daemon.ownerToken : options.owner;
	const contentType =
		options.contentType === undefined ? "application/json" : options.contentType;
	return fetch(url(daemon.port, CHAT_PAIR_CLAIM_PATH), {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${daemon.port}`,
			...(contentType === null ? {} : { "Content-Type": contentType }),
			...(owner === null ? {} : { [OWNER_TOKEN_HEADER]: owner }),
			...(options.origin === undefined ? {} : { Origin: options.origin }),
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

async function createOffer(
	daemon: Daemon,
	origin = EXTENSION_ORIGIN,
): Promise<PairOffer> {
	const response = await offerRequest(daemon.port, origin);
	expect(response.status).toBe(201);
	return validatePairOffer(await response.json());
}

function wrongCode(code: string): string {
	return `${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`;
}

describe("POST /pair/offer", () => {
	it("returns 201 with a uuid, a six digit code and an expiry one TTL ahead", async () => {
		const daemon = await bootDaemon();
		const before = Date.now();

		const response = await offerRequest(daemon.port);
		const offer = validatePairOffer(await response.json());

		expect(response.status).toBe(201);
		expect(offer.offerId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(offer.code).toMatch(PAIR_CODE_PATTERN);
		expect(offer.expiresAt).toBeGreaterThanOrEqual(before + PAIRING_TTL_MS);
		expect(offer.expiresAt).toBeLessThanOrEqual(Date.now() + PAIRING_TTL_MS);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("refuses a browser Origin with 400", async () => {
		const daemon = await bootDaemon();

		expect((await offerRequest(daemon.port, BROWSER_ORIGIN)).status).toBe(400);
	});

	it("refuses a missing Origin with 400", async () => {
		const daemon = await bootDaemon();

		expect((await offerRequest(daemon.port, null)).status).toBe(400);
	});

	it("returns 409 for a second extension origin while one is pinned", async () => {
		const daemon = await bootDaemon();
		writeConfig(daemon.paths, { pinnedOrigin: EXTENSION_ORIGIN });

		const response = await offerRequest(daemon.port, OTHER_EXTENSION_ORIGIN);

		expect(response.status).toBe(409);
		expect(await response.text()).toContain("dg-daemon origin clear");
	});

	it("supersedes the pinned origin's pending offer on a repeat POST", async () => {
		const daemon = await bootDaemon();
		writeConfig(daemon.paths, { pinnedOrigin: EXTENSION_ORIGIN });
		const first = await createOffer(daemon);

		const second = await createOffer(daemon);

		expect(second.offerId).not.toBe(first.offerId);
		const stale = await statusRequest(daemon.port, first.offerId);
		expect(stale.status).toBe(200);
		expect(validatePairOfferStatus(await stale.json())).toEqual({
			status: "expired",
		});
		expect((await statusRequest(daemon.port, first.offerId)).status).toBe(404);
		expect((await statusRequest(daemon.port, second.offerId)).status).toBe(200);
	});

	it("keeps the pinned origin below the outstanding cap across many repeats", async () => {
		const daemon = await bootDaemon();
		writeConfig(daemon.paths, { pinnedOrigin: EXTENSION_ORIGIN });

		for (let index = 0; index < 12; index++) {
			expect((await offerRequest(daemon.port)).status).toBe(201);
		}
	});

	it("does not offer the retired POST /pair route", async () => {
		const daemon = await bootDaemon();

		const response = await fetch(url(daemon.port, "/pair"), {
			method: "POST",
			headers: {
				Host: `127.0.0.1:${daemon.port}`,
				Origin: EXTENSION_ORIGIN,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ code: "123456" }),
		});

		expect(response.status).toBe(404);
	});
});

describe("POST /pair/offer/<offerId>", () => {
	it("returns pending before the claim", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);

		const response = await statusRequest(daemon.port, offer.offerId);

		expect(response.status).toBe(200);
		expect(validatePairOfferStatus(await response.json())).toEqual({
			status: "pending",
			expiresAt: offer.expiresAt,
		});
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("returns 400 when the status request has no Origin header", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);

		expect((await statusRequest(daemon.port, offer.offerId, null)).status).toBe(
			400,
		);
	});

	it("does not serve the status read over GET", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);

		const response = await fetch(
			url(daemon.port, `${CHAT_PAIR_OFFER_PATH}/${offer.offerId}`),
			{
				headers: {
					Host: `127.0.0.1:${daemon.port}`,
					Origin: EXTENSION_ORIGIN,
				},
			},
		);

		expect(response.status).not.toBe(200);
	});

	it("returns 404 for an unknown uuid", async () => {
		const daemon = await bootDaemon();

		const response = await statusRequest(daemon.port, crypto.randomUUID());

		expect(response.status).toBe(404);
		expect(await response.text()).toBe("no pairing offer with that id");
	});

	it.each([
		["a non-uuid id", "not-a-uuid"],
		["a numeric id", "123456"],
	])("returns 404 for %s", async (_name, id) => {
		const daemon = await bootDaemon();
		await createOffer(daemon);

		expect((await statusRequest(daemon.port, id)).status).toBe(404);
	});

	it("returns 404 for an extra path segment after a real id", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);

		const response = await fetch(
			url(daemon.port, `${CHAT_PAIR_OFFER_PATH}/${offer.offerId}/extra`),
			{
				method: "POST",
				headers: {
					Host: `127.0.0.1:${daemon.port}`,
					Origin: EXTENSION_ORIGIN,
				},
			},
		);

		expect(response.status).toBe(404);
	});

	it("returns 404 to another extension origin when none is pinned, before and after the claim", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);
		await claimRequest(daemon, { code: offer.code, sessionId: session.sessionId });

		expect(
			(await statusRequest(daemon.port, offer.offerId, OTHER_EXTENSION_ORIGIN))
				.status,
		).toBe(404);
		expect((await statusRequest(daemon.port, offer.offerId)).status).toBe(200);
	});

	it("returns 409 to another origin while one is pinned, before any lookup", async () => {
		const daemon = await bootDaemon();
		writeConfig(daemon.paths, { pinnedOrigin: EXTENSION_ORIGIN });
		const offer = await createOffer(daemon);

		for (const id of [offer.offerId, crypto.randomUUID()]) {
			expect(
				(await statusRequest(daemon.port, id, OTHER_EXTENSION_ORIGIN)).status,
			).toBe(409);
		}
	});

	it("refuses a browser Origin with 400", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);

		expect(
			(await statusRequest(daemon.port, offer.offerId, BROWSER_ORIGIN)).status,
		).toBe(400);
	});

	it("returns 404 after a daemon restart with a pending offer", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);

		await daemon.restart();

		expect((await statusRequest(daemon.port, offer.offerId)).status).toBe(404);
	});
});

describe("POST /pair/claim", () => {
	it("returns 200 and the next poll carries the claiming session's bootstrap once", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port, {
			agentIdentity: "claude",
		});
		const credentials = await sessionCredentials(
			daemon.dgHome,
			session.sessionId,
		);

		const claim = await claimRequest(daemon, {
			code: offer.code,
			sessionId: session.sessionId,
		});

		expect(claim.status).toBe(200);
		expect(await claim.json()).toEqual({ ok: true, agentIdentity: "claude" });
		expect(claim.headers.get("cache-control")).toBe("no-store");
		expect(claim.headers.get("x-content-type-options")).toBe("nosniff");
		const poll = await statusRequest(daemon.port, offer.offerId);
		const status = validatePairOfferStatus(await poll.json());
		expect(poll.headers.get("cache-control")).toBe("no-store");
		expect(status).toEqual({
			status: "claimed",
			bootstrap: {
				port: daemon.port,
				sessionId: session.sessionId,
				token: credentials.token,
				agentIdentity: "claude",
			},
		});
		expect((await statusRequest(daemon.port, offer.offerId)).status).toBe(404);
	});

	it("gives two offers from two origins two different bootstraps", async () => {
		const daemon = await bootDaemon();
		const offerA = await createOffer(daemon, EXTENSION_ORIGIN);
		const offerB = await createOffer(daemon, OTHER_EXTENSION_ORIGIN);
		const sessionA = await registerSession(daemon.port, { agentIdentity: "a" });
		const sessionB = await registerSession(daemon.port, { agentIdentity: "b" });

		const claimB = await claimRequest(daemon, {
			code: offerB.code,
			sessionId: sessionB.sessionId,
		});
		const claimA = await claimRequest(daemon, {
			code: offerA.code,
			sessionId: sessionA.sessionId,
		});

		expect(claimA.status).toBe(200);
		expect(claimB.status).toBe(200);
		const pollA = validatePairOfferStatus(
			await (await statusRequest(daemon.port, offerA.offerId, EXTENSION_ORIGIN)).json(),
		);
		const pollB = validatePairOfferStatus(
			await (
				await statusRequest(daemon.port, offerB.offerId, OTHER_EXTENSION_ORIGIN)
			).json(),
		);
		if (pollA.status !== "claimed" || pollB.status !== "claimed") {
			throw new Error("both offers should be claimed");
		}
		expect(pollA.bootstrap.sessionId).toBe(sessionA.sessionId);
		expect(pollB.bootstrap.sessionId).toBe(sessionB.sessionId);
		expect(pollA.bootstrap.token).not.toBe(pollB.bootstrap.token);
		expect(pollA.bootstrap.agentIdentity).toBe("a");
		expect(pollB.bootstrap.agentIdentity).toBe("b");
	});

	it("refuses a missing owner token with 401 and leaves the offer pending", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);

		const response = await claimRequest(
			daemon,
			{ code: offer.code, sessionId: session.sessionId },
			{ owner: null },
		);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("refused");
		const poll = validatePairOfferStatus(
			await (await statusRequest(daemon.port, offer.offerId)).json(),
		);
		expect(poll.status).toBe("pending");
	});

	it("refuses a wrong owner token with 401 without counting a failure", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);

		for (let attempt = 0; attempt < 8; attempt++) {
			expect(
				(
					await claimRequest(
						daemon,
						{ code: wrongCode(offer.code), sessionId: session.sessionId },
						{ owner: "not-the-owner-token" },
					)
				).status,
			).toBe(401);
		}

		expect(
			(await claimRequest(daemon, { code: offer.code, sessionId: session.sessionId }))
				.status,
		).toBe(200);
	});

	it("refuses any Origin header with 400 and leaves the offer pending", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);

		const response = await claimRequest(
			daemon,
			{ code: offer.code, sessionId: session.sessionId },
			{ origin: EXTENSION_ORIGIN },
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("refused: /pair/claim is loopback-only");
		const poll = validatePairOfferStatus(
			await (await statusRequest(daemon.port, offer.offerId)).json(),
		);
		expect(poll.status).toBe("pending");
	});

	it("refuses a non-JSON content type with 415", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);

		const response = await claimRequest(
			daemon,
			{ code: offer.code, sessionId: session.sessionId },
			{ contentType: "text/plain" },
		);

		expect(response.status).toBe(415);
	});

	it.each([
		["a short code", { code: "123", sessionId: "s" }],
		["a missing session id", { code: "123456" }],
		["a non-object body", "[]"],
		["invalid JSON", "{nope"],
	])("refuses %s with 400", async (_name, body) => {
		const daemon = await bootDaemon();

		expect((await claimRequest(daemon, body)).status).toBe(400);
	});

	it("answers a wrong code with 404 and the exact text", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);

		const response = await claimRequest(daemon, {
			code: wrongCode(offer.code),
			sessionId: session.sessionId,
		});

		expect(response.status).toBe(404);
		expect(await response.text()).toBe(MISSING_OFFER_TEXT);
	});

	it("answers the code of an already claimed offer with 404 when claimed by another session", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const first = await registerSession(daemon.port);
		const second = await registerSession(daemon.port);
		await claimRequest(daemon, { code: offer.code, sessionId: first.sessionId });

		const response = await claimRequest(daemon, {
			code: offer.code,
			sessionId: second.sessionId,
		});

		expect(response.status).toBe(404);
		expect(await response.text()).toBe(MISSING_OFFER_TEXT);
	});

	it("answers an unknown session with 404 and leaves the offer untouched", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);

		for (let attempt = 0; attempt < 8; attempt++) {
			const response = await claimRequest(daemon, {
				code: offer.code,
				sessionId: "no-such-session",
			});
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("session not found");
		}

		expect(
			(await claimRequest(daemon, { code: offer.code, sessionId: session.sessionId }))
				.status,
		).toBe(200);
	});

	it("answers a superseded offer's code with 410", async () => {
		const daemon = await bootDaemon();
		const first = await createOffer(daemon);
		await createOffer(daemon);
		const session = await registerSession(daemon.port);

		const response = await claimRequest(daemon, {
			code: first.code,
			sessionId: session.sessionId,
		});

		expect(response.status).toBe(410);
		expect(await response.text()).toBe(
			"pairing offer expired; open the extension popup for a new code",
		);
	});

	it("answers the same session claimed twice with 200 both times", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port, {
			agentIdentity: "claude",
		});
		const body = { code: offer.code, sessionId: session.sessionId };

		const first = await claimRequest(daemon, body);
		const second = await claimRequest(daemon, body);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ ok: true, agentIdentity: "claude" });
	});

	it("answers a replay from the session the extension already holds with 200 after the poll", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port, {
			agentIdentity: "claude",
		});
		const body = { code: offer.code, sessionId: session.sessionId };
		expect((await claimRequest(daemon, body)).status).toBe(200);
		expect((await statusRequest(daemon.port, offer.offerId)).status).toBe(200);

		const replay = await claimRequest(daemon, body);

		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ ok: true, agentIdentity: "claude" });
	});

	it("does not count a replay from the holding session toward the lockout", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);
		const body = { code: offer.code, sessionId: session.sessionId };
		await claimRequest(daemon, body);
		await statusRequest(daemon.port, offer.offerId);

		for (let attempt = 0; attempt < 8; attempt++) {
			expect((await claimRequest(daemon, body)).status).toBe(200);
		}
	});

	it("answers a polled code from a different session with 404 and counts it toward the lockout", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const holder = await registerSession(daemon.port);
		const other = await registerSession(daemon.port);
		await claimRequest(daemon, { code: offer.code, sessionId: holder.sessionId });
		await statusRequest(daemon.port, offer.offerId);
		const fresh = await createOffer(daemon);

		for (let attempt = 0; attempt < 5; attempt++) {
			const response = await claimRequest(daemon, {
				code: offer.code,
				sessionId: other.sessionId,
			});
			expect(response.status).toBe(404);
			expect(await response.text()).toBe(MISSING_OFFER_TEXT);
		}
		const locked = await claimRequest(daemon, {
			code: fresh.code,
			sessionId: other.sessionId,
		});

		expect(locked.status).toBe(429);
		expect(await locked.text()).toBe(LOCKED_TEXT);
	});

	it("keeps answering a replayed code with 200 while a newer offer leaves the claimed bootstrap pollable", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);
		const body = { code: offer.code, sessionId: session.sessionId };
		await claimRequest(daemon, body);
		await createOffer(daemon);

		expect((await claimRequest(daemon, body)).status).toBe(200);
		const poll = validatePairOfferStatus(
			await (await statusRequest(daemon.port, offer.offerId)).json(),
		);
		expect(poll.status).toBe("claimed");
	});

	it("claims a new offer for a session that already claimed an earlier one", async () => {
		const daemon = await bootDaemon();
		const first = await createOffer(daemon);
		const session = await registerSession(daemon.port);
		await claimRequest(daemon, { code: first.code, sessionId: session.sessionId });
		await statusRequest(daemon.port, first.offerId);
		const second = await createOffer(daemon);

		const response = await claimRequest(daemon, {
			code: second.code,
			sessionId: session.sessionId,
		});

		expect(response.status).toBe(200);
		const poll = validatePairOfferStatus(
			await (await statusRequest(daemon.port, second.offerId)).json(),
		);
		expect(poll.status).toBe("claimed");
	});

	it("answers a wrong code from a session that already claimed with 404", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);
		await claimRequest(daemon, { code: offer.code, sessionId: session.sessionId });

		const response = await claimRequest(daemon, {
			code: wrongCode(offer.code),
			sessionId: session.sessionId,
		});

		expect(response.status).toBe(404);
		expect(await response.text()).toBe(MISSING_OFFER_TEXT);
	});

	it("locks after five wrong codes and expires the outstanding offer", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);

		for (let attempt = 0; attempt < 5; attempt++) {
			expect(
				(
					await claimRequest(daemon, {
						code: wrongCode(offer.code),
						sessionId: session.sessionId,
					})
				).status,
			).toBe(404);
		}
		const sixth = await claimRequest(daemon, {
			code: offer.code,
			sessionId: session.sessionId,
		});

		expect(sixth.status).toBe(429);
		expect(await sixth.text()).toBe(LOCKED_TEXT);
		const poll = await statusRequest(daemon.port, offer.offerId);
		expect(validatePairOfferStatus(await poll.json())).toEqual({
			status: "expired",
		});
	});

	it("keeps the lockout after a fresh offer is created", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);
		for (let attempt = 0; attempt < 5; attempt++) {
			await claimRequest(daemon, {
				code: wrongCode(offer.code),
				sessionId: session.sessionId,
			});
		}
		const fresh = await createOffer(daemon);

		const response = await claimRequest(daemon, {
			code: fresh.code,
			sessionId: session.sessionId,
		});

		expect(response.status).toBe(429);
	});

	it("does not leak the code or the session token into the daemon log", async () => {
		const daemon = await bootDaemon();
		const offer = await createOffer(daemon);
		const session = await registerSession(daemon.port);
		const credentials = await sessionCredentials(
			daemon.dgHome,
			session.sessionId,
		);
		await claimRequest(daemon, { code: offer.code, sessionId: session.sessionId });
		await statusRequest(daemon.port, offer.offerId);

		const log = readDaemonLog(daemon.dgHome);

		expect(log).not.toContain(offer.code);
		expect(log).not.toContain(credentials.token);
	});

	it("leaves dg-daemon pair code files untouched by offers", async () => {
		const daemon = await bootDaemon();
		const command = await runDaemonCommand(daemon.dgHome, "pair");
		expect(command.stdout).toMatch(/Pairing code: \d{6}/);

		await createOffer(daemon);

		expect(existsSync(daemon.paths.pairingPath)).toBe(true);
	});
});

describe("pair offer capacity", () => {
	it("answers 429 with the exact text on the ninth outstanding offer", async () => {
		const daemon = await bootDaemon();
		const lastResponses: Response[] = [];
		for (let index = 0; index < 9; index++) {
			lastResponses.push(
				await offerRequest(
					daemon.port,
					`chrome-extension://${String.fromCharCode(97 + index).repeat(32)}`,
				),
			);
		}

		expect(lastResponses.slice(0, 8).every((r) => r.status === 201)).toBe(true);
		expect(lastResponses[8]?.status).toBe(429);
		expect(await lastResponses[8]?.text()).toBe(FULL_TEXT);
	});
});
