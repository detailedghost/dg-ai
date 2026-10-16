import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig, resolveEnv } from "../src/config";
import {
	CUSTOM_REACTION_ID,
	isCustomReactionId,
	preflight,
	validateReactionIds,
} from "../src/providers/teams-relay";
import {
	BOT_NAME,
	completeFunPool,
	createTempHome,
	minimalConfigJson,
	type TempHome,
	writeConfigFile,
} from "./support/fakes";

const SECRET = "preflight-secret-77";
const HEX32 = "0123456789abcdef0123456789abcdef";
const CUSTOM_ID = `cust_a;0-cus-d1-${HEX32}`;
const CHAT_ID = "19:abc123@thread.v2";

let home: TempHome;
beforeEach(() => {
	home = createTempHome();
});
afterEach(() => {
	home.cleanup();
});

type Capture = { status: number; signal: null; stdout: string; stderr: string };

function buildConfig(extra: Record<string, unknown> = {}) {
	return loadConfig(
		writeConfigFile(
			home.dir,
			minimalConfigJson({ fun: { pool: completeFunPool() }, ...extra }),
		),
	);
}

function listedFor(config: ReturnType<typeof buildConfig>): string[] {
	return [
		...Object.values(config.reactions),
		...completeFunPool().flatMap((entry) =>
			entry.kind === "emoji" ? [entry.reactionId] : [],
		),
	];
}

function createRig(
	config: ReturnType<typeof buildConfig>,
	options: {
		envName?: "dev" | "prod";
		aws?: Partial<Capture>;
		secret?: string;
		listed?: string[];
		eventsStatus?: number;
		chats?: unknown[];
		chatListResponse?: () => Response;
		reactResponse?: () => Response;
	} = {},
) {
	const env = resolveEnv(config, options.envName);
	const fetched: {
		url: string;
		signal?: AbortSignal;
		redirect?: RequestRedirect;
		body?: ReadableStream | null;
	}[] = [];
	const canceled: boolean[] = [];
	const awsCalls: { command: string; args: string[] }[] = [];
	const fetchFake = (async (input: unknown, init: RequestInit = {}) => {
		const url = String(input);
		const entry: (typeof fetched)[number] = {
			url,
			signal: init.signal ?? undefined,
			redirect: init.redirect,
		};
		fetched.push(entry);
		if (url.endsWith("/chat/list")) {
			return options.chatListResponse
				? options.chatListResponse()
				: Response.json(options.chats ?? []);
		}
		if (url.endsWith("/message/teams/react")) {
			if (options.reactResponse) return options.reactResponse();
			return Response.json(
				(options.listed ?? listedFor(config)).map((id) => ({
					id,
					name: id,
					emoji: "",
				})),
			);
		}
		if (url.endsWith("/events")) {
			const code = options.eventsStatus ?? 200;
			if (code !== 200) return new Response("denied-body", { status: code });
			return new Response(
				new ReadableStream({
					cancel() {
						canceled.push(true);
					},
				}),
				{ status: 200 },
			);
		}
		throw new Error(`unscripted ${url}`);
	}) as unknown as typeof fetch;
	const runCapture = async (
		command: string,
		args: string[],
	): Promise<Capture> => {
		awsCalls.push({ command, args });
		return {
			status: 0,
			signal: null,
			stdout: JSON.stringify({ [config.relay.secret.key]: SECRET }),
			stderr: "",
			...options.aws,
		};
	};
	return {
		env,
		fetched,
		awsCalls,
		run: () =>
			preflight({
				config,
				env,
				fetch: fetchFake,
				runCapture,
				which: () => "/usr/bin/aws",
				secret: options.secret,
			}),
		eventsWasClosed: () => {
			const events = fetched.find((entry) => entry.url.endsWith("/events"));
			return events?.signal?.aborted === true || canceled.length > 0;
		},
	};
}

describe("preflight", () => {
	test("uses a resolved relay secret without calling AWS", async () => {
		const rig = createRig(buildConfig({ chat: { id: CHAT_ID } }), {
			secret: SECRET,
			aws: { status: 255, stderr: "AWS must not run" },
		});
		const report = await rig.run();
		expect(report.secret).toBe("ok");
		expect(report.chats).toMatchObject([{ id: CHAT_ID }]);
		expect(rig.awsCalls).toEqual([]);
		expect(JSON.stringify(report)).not.toContain(SECRET);
	});

	test("reports every check ok for a healthy dev env with a topic lookup", async () => {
		const config = buildConfig();
		const rig = createRig(config, {
			chats: [{ id: CHAT_ID, topic: "Team Reviews" }],
		});
		const report = await rig.run();
		expect(report.env).toBe("dev");
		expect(report.secret).toBe("ok");
		expect(report.chats).toMatchObject([{ id: CHAT_ID }]);
		expect(report.reactions).toBe("ok");
	});

	test("sends every request with redirect error for the events check, chat list, and reactions", async () => {
		const byChatId = createRig(buildConfig({ chat: { id: CHAT_ID } }));
		await byChatId.run();
		const byTopic = createRig(buildConfig(), {
			chats: [{ id: CHAT_ID, topic: "Team Reviews" }],
		});
		await byTopic.run();
		const all = [...byChatId.fetched, ...byTopic.fetched];
		expect(all.some((entry) => entry.url.endsWith("/events"))).toBe(true);
		expect(all.some((entry) => entry.url.endsWith("/chat/list"))).toBe(true);
		expect(
			all.some((entry) => entry.url.endsWith("/message/teams/react")),
		).toBe(true);
		for (const entry of all) expect(entry.redirect).toBe("error");
	});

	test("calls aws with the prod profile and fetches from the prod base URL", async () => {
		const config = buildConfig();
		const rig = createRig(config, {
			envName: "prod",
			chats: [{ id: CHAT_ID, topic: "Team Reviews" }],
		});
		const report = await rig.run();
		expect(report.env).toBe("prod");
		const args = rig.awsCalls[0]?.args ?? [];
		expect(args[args.indexOf("--profile") + 1]).toBe("example-prod");
		expect(rig.fetched.length).toBeGreaterThan(0);
		for (const entry of rig.fetched)
			expect(entry.url.startsWith(rig.env.baseUrl)).toBe(true);
	});

	test("skips chat and reactions when the secret fetch fails with an SSO error", async () => {
		const config = buildConfig();
		const rig = createRig(config, {
			envName: "prod",
			aws: { status: 255, stderr: "SSO session has expired", stdout: SECRET },
		});
		const report = await rig.run();
		expect(report.secret).toEqual({
			error: expect.stringContaining("aws sso login --profile example-prod"),
		});
		expect(report.chats).toBe("skipped");
		expect(report.reactions).toBe("skipped");
		expect(rig.fetched).toHaveLength(0);
		expect(JSON.stringify(report)).not.toContain(SECRET);
	});

	test("with chat.id set never lists chats, reports ok on an events 200, and closes the stream", async () => {
		const config = buildConfig({ chat: { id: CHAT_ID } });
		const rig = createRig(config);
		const report = await rig.run();
		expect(report.chats).toMatchObject([{ id: CHAT_ID }]);
		expect(rig.fetched.some((entry) => entry.url.endsWith("/chat/list"))).toBe(
			false,
		);
		const events = rig.fetched.find((entry) => entry.url.endsWith("/events"));
		expect(events?.url).toBe(
			`${rig.env.baseUrl}/chat/${encodeURIComponent(CHAT_ID)}/events`,
		);
		expect(rig.eventsWasClosed()).toBe(true);
	});

	test("with chat.id set maps an events 404 to the not-member remedy", async () => {
		const config = buildConfig({ chat: { id: CHAT_ID } });
		const rig = createRig(config, { eventsStatus: 404 });
		const report = await rig.run();
		expect(report.chats).toEqual([
			{ error: expect.stringContaining(BOT_NAME) },
		]);
		expect(rig.fetched.some((entry) => entry.url.endsWith("/chat/list"))).toBe(
			false,
		);
		expect(JSON.stringify(report)).not.toContain("denied-body");
	});

	test("checks every configured chat and reports each one", async () => {
		const other = "19:other@thread.v2";
		const config = buildConfig({
			chats: [{ id: CHAT_ID }, { id: other }, { topic: "Missing" }],
		});
		const rig = createRig(config, { chats: [] });
		const report = await rig.run();
		expect(report.chats).toEqual([
			{ id: CHAT_ID },
			{ id: other },
			{ error: expect.stringContaining("Missing") },
		]);
		const checked = rig.fetched.filter((entry) =>
			entry.url.endsWith("/events"),
		);
		expect(checked.map((entry) => entry.url)).toEqual([
			`${rig.env.baseUrl}/chat/${encodeURIComponent(CHAT_ID)}/events`,
			`${rig.env.baseUrl}/chat/${encodeURIComponent(other)}/events`,
		]);
		expect(report.reactions).toBe("ok");
	});

	test("reports a chat error and still checks reactions when the topic is not found", async () => {
		const config = buildConfig();
		const rig = createRig(config, { chats: [] });
		const report = await rig.run();
		expect(report.chats).toEqual([
			{ error: expect.stringContaining("--chat-id") },
		]);
		expect(report.reactions).toBe("ok");
	});

	test("reports a reactions error naming the config key of an unlisted reaction id", async () => {
		const config = buildConfig();
		const listed = listedFor(config).filter(
			(id) => id !== config.reactions.pending,
		);
		const rig = createRig(config, {
			listed,
			chats: [{ id: CHAT_ID, topic: "Team Reviews" }],
		});
		const report = await rig.run();
		expect(report.reactions).toEqual({
			error: expect.stringContaining("reactions.pending"),
		});
		expect(report.secret).toBe("ok");
	});

	test("lists a fun pool emoji id that is not listed as dropped, not as an error", async () => {
		const config = buildConfig();
		const missing = completeFunPool().find((entry) => entry.kind === "emoji");
		const listed = listedFor(config).filter(
			(id) => id !== (missing?.kind === "emoji" ? missing.reactionId : ""),
		);
		const rig = createRig(config, {
			listed,
			chats: [{ id: CHAT_ID, topic: "Team Reviews" }],
		});
		const report = await rig.run();
		const index = completeFunPool().findIndex(
			(entry) => entry.kind === "emoji",
		);
		expect(report.reactions).toBe("ok");
		expect(report.funPool).toEqual({
			dropped: [expect.stringContaining(`fun.pool[${index}].reactionId`)],
		});
	});
});

describe("preflight credential and body hygiene", () => {
	const apiCode = () => Buffer.from(`${BOT_NAME}:${SECRET}`).toString("base64");

	function expectClean(report: unknown) {
		const text = JSON.stringify(report);
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain(SECRET.slice(2, 12));
		expect(text).not.toContain(apiCode());
		expect(text).not.toContain(apiCode().slice(4, 16));
		expect(text).not.toContain("LEAKMARK");
		expect(text).not.toContain("denied-body");
	}

	test.each([401, 500])(
		"a %i on the chat list after a good secret leaks neither credential nor body",
		async (code) => {
			const config = buildConfig();
			const rig = createRig(config, {
				chatListResponse: () =>
					new Response("LEAKMARK denied-body", { status: code }),
			});
			const report = await rig.run();
			expect(report.secret).toBe("ok");
			expect(Array.isArray(report.chats)).toBe(true);
			expectClean(report);
		},
	);

	test.each([401, 500])(
		"a %i on the reaction check after a good secret leaks neither credential nor body",
		async (code) => {
			const config = buildConfig();
			const rig = createRig(config, {
				chats: [{ id: CHAT_ID, topic: "Team Reviews" }],
				reactResponse: () =>
					new Response("LEAKMARK denied-body", { status: code }),
			});
			const report = await rig.run();
			expect(report.secret).toBe("ok");
			expect(typeof report.reactions).toBe("object");
			expectClean(report);
		},
	);

	test("a 200 chat list body that is not JSON leaks nothing", async () => {
		const config = buildConfig();
		const rig = createRig(config, {
			chatListResponse: () => new Response("LEAKMARK <html>", { status: 200 }),
		});
		const report = await rig.run();
		expect(Array.isArray(report.chats)).toBe(true);
		expectClean(report);
	});

	test("a 200 reaction catalog body that is not JSON leaks nothing", async () => {
		const config = buildConfig();
		const rig = createRig(config, {
			chats: [{ id: CHAT_ID, topic: "Team Reviews" }],
			reactResponse: () => new Response("LEAKMARK <html>", { status: 200 }),
		});
		const report = await rig.run();
		expect(typeof report.reactions).toBe("object");
		expectClean(report);
	});

	test("an events 500 with chat.id set leaks neither credential nor body", async () => {
		const config = buildConfig({ chat: { id: CHAT_ID } });
		const rig = createRig(config, { eventsStatus: 500 });
		const report = await rig.run();
		expect(Array.isArray(report.chats)).toBe(true);
		expectClean(report);
	});
});

describe("CUSTOM_REACTION_ID and isCustomReactionId", () => {
	test("accept a custom reaction id and agree with the exported pattern", () => {
		expect(isCustomReactionId(CUSTOM_ID)).toBe(true);
		expect(CUSTOM_REACTION_ID.test(CUSTOM_ID)).toBe(true);
	});

	test.each([
		["cus", `cust;0-cus-d1-${HEX32}`],
		["wus", `party-blob;0-wus-d8-${HEX32}`],
		["eus", `cust;0-eus-d20-${HEX32}`],
	])("accept a custom reaction id from the %s region", (_name, id) => {
		expect(isCustomReactionId(id)).toBe(true);
	});

	test.each([
		["31 hex digits", `cust;0-cus-d1-${HEX32.slice(1)}`],
		["an uppercase region", `cust;0-WUS-d1-${HEX32}`],
		["a missing region", `cust;0-d1-${HEX32}`],
		["a four digit d segment", `cust;0-cus-d1234-${HEX32}`],
		["no prefix", `;0-cus-d1-${HEX32}`],
		["a built-in id", "2705_whiteheavycheckmark"],
		["a trailing character", `${CUSTOM_ID}x`],
	])("reject %s", (_name, id) => {
		expect(isCustomReactionId(id)).toBe(false);
	});
});

describe("validateReactionIds", () => {
	test("accepts a listed id and a custom id that is not listed", () => {
		expect(() =>
			validateReactionIds(
				{ "reactions.pending": "eyes", "reactions.approved": CUSTOM_ID },
				["eyes"],
			),
		).not.toThrow();
	});

	test("rejects a malformed custom id naming the config key", () => {
		expect(() =>
			validateReactionIds({ "reactions.comment": "bad;0-cus-d1-zz" }, [
				"bad;0-cus-d1-zz",
			]),
		).toThrow("reactions.comment");
	});

	test("rejects an unlisted built-in id naming the config key", () => {
		expect(() =>
			validateReactionIds({ "reactions.failure": "ghost" }, ["eyes"]),
		).toThrow("reactions.failure");
	});
});
