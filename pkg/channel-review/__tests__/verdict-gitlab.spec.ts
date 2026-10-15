import { describe, expect, test } from "bun:test";
import { createVerdictReader } from "../src/verdict";
import { VerdictError } from "../src/verdict/types";

type Capture = {
	status: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

const SINCE = new Date("2026-10-14T12:00:00Z");
const HOST = "gitlab.example.com";
const URL = `https://${HOST}/group/sub/repo/-/merge_requests/5`;
const PROJECT = encodeURIComponent("group/sub/repo");
const ME = "reviewer";
const MINUTE = 60_000;

const at = (offsetMs: number) =>
	new Date(SINCE.getTime() + offsetMs).toISOString();

type Note = {
	author: { username: string };
	created_at: string;
	body: string;
	type?: string | null;
};

function note(
	username: string,
	offsetMs: number,
	body = "a note",
	type: string | null = null,
): Note {
	return { author: { username }, created_at: at(offsetMs), body, type };
}

const summary = (label: string, offsetMs = 2 * MINUTE, username = ME) =>
	note(username, offsetMs, `## Thrash review\n\n${label}\n\ndetails`);

type Fixture = {
	notes?: Note[];
	approvedBy?: string[];
	discussions?: {
		notes: (Note & { resolvable: boolean; resolved: boolean })[];
		resolved: boolean;
	}[];
	override?: (endpoint: string) => Capture | undefined;
	which?: (name: string) => string | undefined;
};

const ok = (stdout: string): Capture => ({
	status: 0,
	signal: null,
	stdout,
	stderr: "",
});
const fail = (status: number, stderr: string): Capture => ({
	status,
	signal: null,
	stdout: "",
	stderr,
});

function discussion(username: string, offsetMs: number, resolved: boolean) {
	return {
		resolved,
		notes: [
			{
				...note(username, offsetMs, "inline", "DiscussionNote"),
				resolvable: true,
				resolved,
			},
		],
	};
}

function setup(fixture: Fixture = {}) {
	const calls: { command: string; args: string[]; options: unknown }[] = [];
	const endpoints: string[] = [];
	let userCalls = 0;
	const runCapture = async (
		command: string,
		args: string[],
		opts?: unknown,
	): Promise<Capture> => {
		calls.push({ command, args, options: opts });
		if (args[0] === "auth") return ok("");
		const endpoint = args.find((arg) => arg === "user" || arg.startsWith("projects/"));
		endpoints.push(endpoint ?? "");
		const forced = fixture.override?.(endpoint ?? "");
		if (forced) return forced;
		if (endpoint === "user") {
			userCalls += 1;
			return ok(JSON.stringify({ username: ME }));
		}
		const page = Number(endpoint?.match(/[?&]page=(\d+)/)?.[1] ?? 1);
		if (endpoint?.includes("/approvals")) {
			return ok(
				JSON.stringify({
					approved_by: (fixture.approvedBy ?? []).map((username) => ({
						user: { username },
					})),
				}),
			);
		}
		if (endpoint?.includes("/discussions")) {
			return ok(JSON.stringify(page === 1 ? (fixture.discussions ?? []) : []));
		}
		if (endpoint?.includes("/notes")) {
			return ok(JSON.stringify(page === 1 ? (fixture.notes ?? []) : []));
		}
		return fail(1, "unexpected endpoint");
	};
	const reader = createVerdictReader({
		runCapture,
		which: fixture.which ?? ((name: string) => `/usr/bin/${name}`),
	});
	return { reader, calls, endpoints, userCallCount: () => userCalls };
}

const read = (reader: ReturnType<typeof createVerdictReader>) =>
	reader.read({ url: URL, host: "gitlab", since: SINCE });

describe("createVerdictReader gitlab summary note", () => {
	test("maps a Request changes summary note to changes_requested even beside a stale approval", async () => {
		const { reader } = setup({
			notes: [summary("**Verdict:** Request changes.")],
			approvedBy: [ME],
		});
		expect(await read(reader)).toBe("changes_requested");
	});

	test("maps an Approve summary note to approved", async () => {
		const { reader } = setup({ notes: [summary("**Verdict:** Approve.")] });
		expect(await read(reader)).toBe("approved");
	});

	test("maps a comment-mode summary note with inline notes to commented", async () => {
		const { reader } = setup({
			notes: [
				summary("**Verdict:** Comment only."),
				note(ME, 2 * MINUTE, "inline one", "DiffNote"),
				note(ME, 2 * MINUTE, "inline two", "DiffNote"),
			],
			discussions: [discussion(ME, 2 * MINUTE, true)],
		});
		expect(await read(reader)).toBe("commented");
	});

	test("takes the newest summary note", async () => {
		const { reader } = setup({
			notes: [
				summary("**Verdict:** Request changes.", MINUTE),
				summary("**Verdict:** Approve.", 6 * MINUTE),
			],
		});
		expect(await read(reader)).toBe("approved");
	});

	test("ignores a summary note by another user", async () => {
		const { reader } = setup({
			notes: [summary("**Verdict:** Request changes.", 2 * MINUTE, "other")],
		});
		expect(await read(reader)).toBe("none");
	});

	test("ignores a summary note from before since minus 2 minutes", async () => {
		const { reader } = setup({
			notes: [summary("**Verdict:** Request changes.", -10 * MINUTE)],
		});
		expect(await read(reader)).toBe("none");
	});

	test("takes a summary note 60 s before since as clock slack", async () => {
		const { reader } = setup({
			notes: [summary("**Verdict:** Approve.", -60_000)],
		});
		expect(await read(reader)).toBe("approved");
	});
});

describe("createVerdictReader gitlab without a summary note", () => {
	test("maps approved_by containing me to approved", async () => {
		const { reader } = setup({ approvedBy: ["other", ME] });
		expect(await read(reader)).toBe("approved");
	});

	test("ignores approved_by that lacks me", async () => {
		const { reader } = setup({ approvedBy: ["other"] });
		expect(await read(reader)).toBe("none");
	});

	test("maps an unresolved discussion started by me after since to changes_requested", async () => {
		const { reader } = setup({
			discussions: [discussion(ME, 2 * MINUTE, false)],
			notes: [note(ME, 2 * MINUTE, "inline", "DiscussionNote")],
		});
		expect(await read(reader)).toBe("changes_requested");
	});

	test("ignores a resolved discussion and falls back to commented for my note", async () => {
		const { reader } = setup({
			discussions: [discussion(ME, 2 * MINUTE, true)],
			notes: [note(ME, 2 * MINUTE, "inline", "DiscussionNote")],
		});
		expect(await read(reader)).toBe("commented");
	});

	test("ignores an unresolved discussion started by someone else", async () => {
		const { reader } = setup({
			discussions: [discussion("other", 2 * MINUTE, false)],
		});
		expect(await read(reader)).toBe("none");
	});

	test("maps a note by me after since to commented", async () => {
		const { reader } = setup({ notes: [note(ME, 3 * MINUTE, "looks fine")] });
		expect(await read(reader)).toBe("commented");
	});

	test("returns none when nothing by me exists after since", async () => {
		const { reader } = setup({
			notes: [note(ME, -30 * MINUTE), note("other", MINUTE)],
		});
		expect(await read(reader)).toBe("none");
	});

	test("returns none for an empty merge request", async () => {
		const { reader } = setup();
		expect(await read(reader)).toBe("none");
	});

	test("does not look at approvals when a summary note exists", async () => {
		const { reader, endpoints } = setup({
			notes: [summary("**Verdict:** Approve.")],
		});
		await read(reader);
		expect(endpoints.some((endpoint) => endpoint.includes("/approvals"))).toBe(
			false,
		);
	});
});

describe("createVerdictReader gitlab calls", () => {
	test("targets the encoded project path and iid with --hostname on every call", async () => {
		const { reader, calls, endpoints } = setup();
		await read(reader);
		expect(
			endpoints.some((endpoint) =>
				endpoint.startsWith(`projects/${PROJECT}/merge_requests/5/`),
			),
		).toBe(true);
		for (const call of calls) {
			expect(call.command).toBe("glab");
			const index = call.args.indexOf("--hostname");
			expect(index).toBeGreaterThanOrEqual(0);
			expect(call.args[index + 1]).toBe(HOST);
			expect(call.options).toMatchObject({ timeoutMs: 60_000 });
		}
	});

	test("asks for the current user once per daemon", async () => {
		const { reader, userCallCount } = setup({ approvedBy: [ME] });
		await read(reader);
		await read(reader);
		expect(userCallCount()).toBe(1);
	});

	test("asks for the current user again on a different host", async () => {
		const { reader, userCallCount } = setup({ approvedBy: [ME] });
		await read(reader);
		await reader.read({
			url: "https://git.other.example/group/repo/-/merge_requests/5",
			host: "gitlab",
			since: SINCE,
		});
		expect(userCallCount()).toBe(2);
	});

	test("does not cache a failed current user lookup", async () => {
		let attempts = 0;
		const { reader } = setup({
			approvedBy: [ME],
			override: (endpoint) => {
				if (endpoint !== "user") return undefined;
				attempts += 1;
				return attempts === 1 ? fail(1, "502 Bad Gateway") : undefined;
			},
		});
		await expect(read(reader)).rejects.toThrow();
		expect(await read(reader)).toBe("approved");
	});

	test("fetches notes page by page", async () => {
		const pageSize = 100;
		const filler = Array.from({ length: pageSize }, () =>
			note("other", MINUTE),
		);
		const seen: number[] = [];
		const reader = createVerdictReader({
			which: () => "/usr/bin/glab",
			runCapture: async (_command: string, args: string[]) => {
				const endpoint = args.find(
					(arg) => arg === "user" || arg.startsWith("projects/"),
				);
				if (endpoint === "user") return ok(JSON.stringify({ username: ME }));
				if (endpoint?.includes("/notes")) {
					const page = Number(endpoint.match(/[?&]page=(\d+)/)?.[1] ?? 1);
					seen.push(page);
					if (page === 1) return ok(JSON.stringify(filler));
					if (page === 2) {
						return ok(
							JSON.stringify([summary("**Verdict:** Approve.", 3 * MINUTE)]),
						);
					}
					return ok("[]");
				}
				return ok(JSON.stringify({ approved_by: [] }));
			},
		});
		expect(await read(reader)).toBe("approved");
		expect(seen).toContain(2);
	});
});

describe("createVerdictReader gitlab errors", () => {
	test.each(["404 Not Found", "403 Forbidden"])("maps %s to CR-302", async (stderr) => {
		const { reader } = setup({
			override: (endpoint) =>
				endpoint.startsWith("projects/") ? fail(1, stderr) : undefined,
		});
		const error = await read(reader).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VerdictError);
		expect((error as VerdictError).code).toBe("CR-302");
	});

	test("maps a missing glab binary to CR-303 on read", async () => {
		const { reader } = setup({ which: () => undefined });
		const error = await read(reader).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VerdictError);
		expect((error as VerdictError).code).toBe("CR-303");
	});
});

describe("createVerdictReader gitlab probe", () => {
	const probeCalls = (status: number) => {
		const calls: { command: string; args: string[] }[] = [];
		const reader = createVerdictReader({
			which: () => "/usr/bin/glab",
			runCapture: async (command: string, args: string[]) => {
				calls.push({ command, args });
				return status === 0 ? ok("") : fail(status, "not logged in");
			},
		});
		return { calls, reader };
	};

	test("returns CR-303 when glab is not on PATH", async () => {
		const { reader } = setup({ which: () => undefined });
		expect(await reader.probe({ host: "gitlab", url: URL })).toEqual({
			ok: false,
			code: "CR-303",
		});
	});

	test("returns CR-303 when glab auth status exits 1", async () => {
		const { calls, reader } = probeCalls(1);
		expect(await reader.probe({ host: "gitlab", url: URL })).toEqual({
			ok: false,
			code: "CR-303",
		});
		expect(calls[0]?.command).toBe("glab");
		expect(calls[0]?.args.slice(0, 2)).toEqual(["auth", "status"]);
	});

	test("returns ok when glab is present and auth status exits 0", async () => {
		const { reader } = setup();
		expect(await reader.probe({ host: "gitlab", url: URL })).toEqual({
			ok: true,
		});
	});

	test("passes --hostname with the url host on auth status", async () => {
		const { calls, reader } = probeCalls(0);
		await reader.probe({ host: "gitlab", url: URL });
		const args = calls[0]?.args ?? [];
		expect(args[args.indexOf("--hostname") + 1]).toBe(HOST);
	});

	test("omits --hostname when no url is given", async () => {
		const { calls, reader } = probeCalls(0);
		await reader.probe({ host: "gitlab" });
		expect(calls[0]?.args).not.toContain("--hostname");
	});
});
