import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { CHAT_EXCHANGE_PATH } from "@dg/common";
import { openFailedHint } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	freshDgHome,
	killDaemonByPidFile,
} from "@dg/dg-daemon/test-harness";
import { cmdStart, type StartOptions, type StartSeams } from "../src/start";

const DAEMON_ENTRY = join(import.meta.dir, "../../dg-daemon/src/index.ts");

let dgHome: string;
let port: number;

async function withDgEnv<T>(fn: () => Promise<T>): Promise<T> {
	const vars = {
		DG_HOME: dgHome,
		DG_PORT: String(port),
		DG_KEY_SOURCE: "file",
	};
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(vars)) saved[key] = process.env[key];
	Object.assign(process.env, vars);
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function runStart(
	options: StartOptions,
	tryOpenResult = true,
	wsl = false,
) {
	const opened: string[] = [];
	const seams: StartSeams = {
		daemonArgv: () => [process.execPath, DAEMON_ENTRY, "__serve"],
		tryOpen: async (url) => {
			opened.push(url);
			return tryOpenResult;
		},
		openFailedHint: () => openFailedHint(wsl),
	};
	const logs: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	console.log = (...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	};
	const errors: string[] = [];
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	};
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await realFetch(input, init);
		if (String(input).endsWith("/start")) await recordIssuedToken(response);
		return response;
	}) as typeof fetch;
	try {
		await withDgEnv(() => cmdStart(options, seams));
	} finally {
		globalThis.fetch = realFetch;
		console.log = originalLog;
		console.error = originalError;
	}
	return { logs, opened, errors };
}

const issuedTokens: string[] = [];

async function recordIssuedToken(response: Response): Promise<void> {
	const body = (await response.clone().json()) as { token?: string };
	if (body.token) issuedTokens.push(body.token);
}

function everyLine(run: { logs: string[]; errors: string[] }): string[] {
	return [...run.logs, ...run.errors];
}

function codeOf(url: string): string {
	return url.split("#_chatcode=")[1] ?? "";
}

describe("dg-agent start output", () => {
	beforeAll(async () => {
		dgHome = freshDgHome();
		port = allocatePort();
		await runStart({});
	}, 30_000);

	afterAll(() => {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	});

	it("prints nothing on stdout by default and the install hint when no extension is linked", async () => {
		const run = await runStart({});

		expect(run.logs).toEqual([]);
		expect(run.errors).toEqual([
			"No browser extension is connected. Install it with: dg-skills install",
		]);
	});

	it("prints one JSON object with sessionId, port, and extensionLinked and no url", async () => {
		const { logs } = await runStart({ json: true });

		expect(logs).toHaveLength(1);
		const payload = JSON.parse(logs[0]) as Record<string, unknown>;
		expect(Object.keys(payload).sort()).toEqual([
			"extensionLinked",
			"port",
			"sessionId",
		]);
		expect(payload.port).toBe(port);
		expect(payload.extensionLinked).toBe(false);
	});

	it("prints only the session id with --print-session-id", async () => {
		const { logs } = await runStart({ printSessionId: true });

		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("does not call tryOpen without --open", async () => {
		const plain = await runStart({});
		const json = await runStart({ json: true });

		expect(plain.opened).toEqual([]);
		expect(json.opened).toEqual([]);
	});

	it("opens /chat with a one-time code on --open and prints no URL", async () => {
		const run = await runStart({ open: true });

		expect(run.opened).toHaveLength(1);
		expect(run.opened[0].startsWith(`http://127.0.0.1:${port}/chat#_chatcode=`)).toBe(true);
		expect(run.logs).toEqual([]);
		expect(everyLine(run).join("\n")).not.toContain("http");
	});

	it("opens a code that exchanges for the session that start registered", async () => {
		const { logs, opened } = await runStart({ open: true, json: true });
		const { sessionId } = JSON.parse(logs[0]) as { sessionId: string };

		const traded = await fetch(`http://127.0.0.1:${port}${CHAT_EXCHANGE_PATH}`, {
			method: "POST",
			headers: {
				Host: `127.0.0.1:${port}`,
				Origin: `http://127.0.0.1:${port}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ code: codeOf(opened[0]) }),
		});

		expect(((await traded.json()) as { sessionId: string }).sessionId).toBe(sessionId);
	});

	it("prints no session token on stdout or stderr in any variant", async () => {
		const runs = [
			await runStart({}),
			await runStart({ json: true }),
			await runStart({ printSessionId: true }),
			await runStart({ open: true }),
			await runStart({ open: true }, false),
		];

		const output = runs.flatMap(everyLine).join("\n");
		expect(issuedTokens.length).toBeGreaterThanOrEqual(runs.length);
		for (const token of issuedTokens) expect(output).not.toContain(token);
	});

	it("registers one new session per start through POST /start and never lists sessions", async () => {
		const requests: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(`${init?.method ?? "GET"} ${new URL(String(input instanceof Request ? input.url : input)).pathname}`);
			return realFetch(input, init);
		}) as typeof fetch;
		let ids: string[];
		try {
			const first = await runStart({ json: true });
			const second = await runStart({ json: true });
			ids = [first, second].map(
				(run) => (JSON.parse(run.logs[0]) as { sessionId: string }).sessionId,
			);
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(requests.filter((request) => request === "POST /start")).toHaveLength(2);
		expect(requests.filter((request) => request.endsWith("/sessions"))).toEqual([]);
		expect(new Set(ids).size).toBe(2);
	});

	it("succeeds and writes one stderr hint when tryOpen reports no browser opened", async () => {
		const { errors } = await runStart({ open: true }, false);

		expect(errors).toContain(openFailedHint(false));
	});

	it("names the DG_OPEN_WINDOWS opt-in on WSL when no browser opened", async () => {
		const { errors } = await runStart({ open: true }, false, true);

		expect(errors).toContain(openFailedHint(true));
		expect(openFailedHint(true)).toContain("DG_OPEN_WINDOWS=1");
	});

	it("writes no could-not-open line when the browser opens", async () => {
		const { errors } = await runStart({ open: true });

		expect(errors).not.toContain(openFailedHint(false));
	});
});
