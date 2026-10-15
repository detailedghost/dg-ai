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
const URL = "https://github.com/o/r/pull/12";
const ME = "reviewer";
const MINUTE = 60_000;

const at = (offsetMs: number) =>
	new Date(SINCE.getTime() + offsetMs).toISOString();

type Review = {
	user: { login: string };
	state: string;
	submitted_at: string | null;
	body: string;
};

function review(
	login: string,
	state: string,
	offsetMs: number | null,
	body = "",
): Review {
	return {
		user: { login },
		state,
		submitted_at: offsetMs === null ? null : at(offsetMs),
		body,
	};
}

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

function setup(
	pages: Review[][],
	options: {
		reviewsResult?: Capture;
		userResults?: Capture[];
		which?: (name: string) => string | undefined;
	} = {},
) {
	const calls: { command: string; args: string[]; options: unknown }[] = [];
	let userCalls = 0;
	const userResults = options.userResults ?? [ok(`${ME}\n`)];
	const runCapture = async (
		command: string,
		args: string[],
		opts?: unknown,
	): Promise<Capture> => {
		calls.push({ command, args, options: opts });
		if (args[0] === "auth") return ok("");
		if (args.includes("user")) {
			const result = userResults[Math.min(userCalls, userResults.length - 1)];
			userCalls += 1;
			return result as Capture;
		}
		return options.reviewsResult ?? ok(JSON.stringify(pages));
	};
	const reader = createVerdictReader({
		runCapture,
		which: options.which ?? ((name: string) => `/usr/bin/${name}`),
	});
	return { reader, calls, userCallCount: () => userCalls };
}

const read = (reader: ReturnType<typeof createVerdictReader>, url = URL) =>
	reader.read({ url, host: "github", since: SINCE });

describe("createVerdictReader github read", () => {
	test("returns the newest review by me after since", async () => {
		const { reader } = setup([
			[
				review(ME, "APPROVED", MINUTE),
				review(ME, "CHANGES_REQUESTED", 3 * MINUTE),
			],
		]);
		expect(await read(reader)).toBe("changes_requested");
	});

	test("orders by submitted_at rather than by array position", async () => {
		const { reader } = setup([
			[
				review(ME, "CHANGES_REQUESTED", 3 * MINUTE),
				review(ME, "APPROVED", 10 * MINUTE),
				review(ME, "COMMENTED", MINUTE),
			],
		]);
		expect(await read(reader)).toBe("approved");
	});

	test("ignores an older review and a newer review by another user", async () => {
		const { reader } = setup([
			[
				review(ME, "APPROVED", -60 * MINUTE),
				review("other", "COMMENTED", MINUTE),
				review(ME, "CHANGES_REQUESTED", 2 * MINUTE),
			],
		]);
		expect(await read(reader)).toBe("changes_requested");
	});

	test("returns none when only an old review by me exists", async () => {
		const { reader } = setup([[review(ME, "APPROVED", -60 * MINUTE)]]);
		expect(await read(reader)).toBe("none");
	});

	test("returns none when only other users reviewed", async () => {
		const { reader } = setup([[review("other", "APPROVED", MINUTE)]]);
		expect(await read(reader)).toBe("none");
	});

	test("returns none for an empty review list", async () => {
		const { reader } = setup([[]]);
		expect(await read(reader)).toBe("none");
	});

	test("takes a review 60 s before since as clock slack", async () => {
		const { reader } = setup([[review(ME, "APPROVED", -60_000)]]);
		expect(await read(reader)).toBe("approved");
	});

	test("ignores a review 3 minutes before since", async () => {
		const { reader } = setup([[review(ME, "APPROVED", -3 * MINUTE)]]);
		expect(await read(reader)).toBe("none");
	});

	test("ignores PENDING reviews with a null submitted_at", async () => {
		const { reader } = setup([
			[review(ME, "PENDING", null), review(ME, "APPROVED", MINUTE)],
		]);
		expect(await read(reader)).toBe("approved");
	});

	test("ignores a newer DISMISSED review", async () => {
		const { reader } = setup([
			[
				review(ME, "CHANGES_REQUESTED", MINUTE),
				review(ME, "DISMISSED", 5 * MINUTE),
			],
		]);
		expect(await read(reader)).toBe("changes_requested");
	});

	test("maps a plain COMMENTED review to commented", async () => {
		const { reader } = setup([[review(ME, "COMMENTED", MINUTE, "nice")]]);
		expect(await read(reader)).toBe("commented");
	});

	test("flattens the pages of a two-page slurp fixture", async () => {
		const { reader } = setup([
			[review(ME, "APPROVED", MINUTE)],
			[review(ME, "CHANGES_REQUESTED", 4 * MINUTE)],
		]);
		expect(await read(reader)).toBe("changes_requested");
	});

	test("finds a review that sits only on the first page", async () => {
		const { reader } = setup([[review(ME, "APPROVED", 4 * MINUTE)], []]);
		expect(await read(reader)).toBe("approved");
	});
});

describe("createVerdictReader github degraded own-PR review", () => {
	const degraded = (label: string, offset = 2 * MINUTE) =>
		review(ME, "COMMENTED", offset, `## Thrash review\n\n${label}\n\nbody`);

	test("maps a Request changes label to changes_requested", async () => {
		const { reader } = setup([[degraded("**Verdict:** Request changes.")]]);
		expect(await read(reader)).toBe("changes_requested");
	});

	test("maps an Approve label to approved", async () => {
		const { reader } = setup([[degraded("**Verdict:** Approve.")]]);
		expect(await read(reader)).toBe("approved");
	});

	test("maps another label to commented", async () => {
		const { reader } = setup([[degraded("**Verdict:** Comment only.")]]);
		expect(await read(reader)).toBe("commented");
	});

	test("does not read the label of a COMMENTED body that does not start with the heading", async () => {
		const { reader } = setup([
			[
				review(
					ME,
					"COMMENTED",
					MINUTE,
					"see below\n## Thrash review\n**Verdict:** Request changes.",
				),
			],
		]);
		expect(await read(reader)).toBe("commented");
	});
});

describe("createVerdictReader github calls", () => {
	test("asks gh for the paginated slurped reviews of the parsed owner, repo, and number", async () => {
		const { reader, calls } = setup([[]]);
		await read(reader);
		const reviewCall = calls.find((call) =>
			call.args.some((arg) => arg.startsWith("repos/o/r/pulls/12/reviews")),
		);
		expect(reviewCall?.command).toBe("gh");
		expect(reviewCall?.args).toContain("--paginate");
		expect(reviewCall?.args).toContain("--slurp");
	});

	test("passes --hostname with the URL host on every gh call", async () => {
		const { reader, calls } = setup([[]]);
		await read(reader, "https://ghe.example.com/o/r/pull/12");
		expect(calls.length).toBeGreaterThanOrEqual(2);
		for (const call of calls) {
			const index = call.args.indexOf("--hostname");
			expect(index).toBeGreaterThanOrEqual(0);
			expect(call.args[index + 1]).toBe("ghe.example.com");
		}
	});

	test("runs every call with a 60 s timeout", async () => {
		const { reader, calls } = setup([[]]);
		await read(reader);
		for (const call of calls) {
			expect(call.options).toMatchObject({ timeoutMs: 60_000 });
		}
	});

	test("asks for the current user once per daemon", async () => {
		const { reader, userCallCount } = setup([[review(ME, "APPROVED", MINUTE)]]);
		await read(reader);
		await read(reader);
		expect(userCallCount()).toBe(1);
	});

	test("does not cache a failed current user lookup", async () => {
		const { reader, userCallCount } = setup(
			[[review(ME, "APPROVED", MINUTE)]],
			{ userResults: [fail(1, "HTTP 502"), ok(`${ME}\n`)] },
		);
		await expect(read(reader)).rejects.toThrow();
		expect(await read(reader)).toBe("approved");
		expect(userCallCount()).toBe(2);
	});
});

describe("createVerdictReader github errors", () => {
	test.each(["HTTP 404: Not Found", "HTTP 403: Forbidden"])("maps %s to CR-302", async (stderr) => {
		const { reader } = setup([], { reviewsResult: fail(1, stderr) });
		const error = await read(reader).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VerdictError);
		expect((error as VerdictError).code).toBe("CR-302");
	});

	test("maps gh exit code 4 to CR-303", async () => {
		const { reader } = setup([], { reviewsResult: fail(4, "auth required") });
		const error = await read(reader).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VerdictError);
		expect((error as VerdictError).code).toBe("CR-303");
	});

	test("maps a missing gh binary to CR-303 on read", async () => {
		const { reader } = setup([[]], { which: () => undefined });
		const error = await read(reader).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VerdictError);
		expect((error as VerdictError).code).toBe("CR-303");
	});
});

describe("createVerdictReader github probe", () => {
	const probeCalls = (url: string | undefined, status: number) => {
		const calls: string[][] = [];
		const reader = createVerdictReader({
			which: () => "/usr/bin/gh",
			runCapture: async (_command: string, args: string[]) => {
				calls.push(args);
				return status === 0 ? ok("") : fail(status, "not logged in");
			},
		});
		return { calls, reader, url };
	};

	test("returns CR-303 when gh is not on PATH", async () => {
		const { reader } = setup([], { which: () => undefined });
		expect(await reader.probe({ host: "github", url: URL })).toEqual({
			ok: false,
			code: "CR-303",
		});
	});

	test("returns CR-303 when gh auth status exits 1", async () => {
		const { calls, reader } = probeCalls(URL, 1);
		expect(await reader.probe({ host: "github", url: URL })).toEqual({
			ok: false,
			code: "CR-303",
		});
		expect(calls[0]?.slice(0, 2)).toEqual(["auth", "status"]);
	});

	test("returns ok when gh is present and auth status exits 0", async () => {
		const { reader } = setup([]);
		expect(await reader.probe({ host: "github", url: URL })).toEqual({
			ok: true,
		});
	});

	test("omits --hostname for a github.com url", async () => {
		const { calls, reader } = probeCalls(URL, 0);
		await reader.probe({ host: "github", url: URL });
		expect(calls[0]).not.toContain("--hostname");
	});

	test("passes --hostname with the url host when it is not github.com", async () => {
		const enterprise = "https://ghe.example.com/o/r/pull/3";
		const { calls, reader } = probeCalls(enterprise, 0);
		await reader.probe({ host: "github", url: enterprise });
		const call = calls[0] ?? [];
		expect(call.slice(0, 2)).toEqual(["auth", "status"]);
		expect(call[call.indexOf("--hostname") + 1]).toBe(
			new globalThis.URL(enterprise).host,
		);
	});

	test("omits --hostname when no url is given", async () => {
		const { calls, reader } = probeCalls(undefined, 0);
		await reader.probe({ host: "github" });
		expect(calls[0]).not.toContain("--hostname");
	});
});
