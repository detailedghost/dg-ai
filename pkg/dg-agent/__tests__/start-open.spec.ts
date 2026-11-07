import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { validateSessionBootstrap } from "@dg/common";
import { openFailedHint } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	decodeChatMarker,
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
	try {
		await withDgEnv(() => cmdStart(options, seams));
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
	return { logs, opened, errors };
}

describe("dg-agent start bootstrap URL", () => {
	beforeAll(async () => {
		dgHome = freshDgHome();
		port = allocatePort();
		await runStart({});
	}, 30_000);

	afterAll(() => {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	});

	it("prints the local /chat page URL by default", async () => {
		const { logs } = await runStart({});
		const url = logs.at(-1) ?? "";
		expect(url.startsWith(`http://127.0.0.1:${port}/chat#_chat=`)).toBe(true);
		const bootstrap = validateSessionBootstrap(decodeChatMarker(url));
		expect(bootstrap.port).toBe(port);
		expect(bootstrap.token.length).toBeGreaterThan(0);
	});

	describe.each([
		["default", {}],
		["--ext", { ext: true }],
	] as const)("%s start variant", (_name, flags) => {
		it("prints the /chat page URL and never the /start page", async () => {
			const { logs } = await runStart({ ...flags });
			const url = logs.at(-1) ?? "";
			expect(url.startsWith(`http://127.0.0.1:${port}/chat#_chat=`)).toBe(
				true,
			);
			expect(url).not.toContain("/start");
			expect(validateSessionBootstrap(decodeChatMarker(url)).port).toBe(port);
		});

		it("carries the /chat URL in the --json url field", async () => {
			const { logs } = await runStart({ ...flags, json: true });
			const payload = JSON.parse(logs.at(-1) ?? "{}") as { url: string };
			expect(payload.url.startsWith(`http://127.0.0.1:${port}/chat#_chat=`)).toBe(
				true,
			);
		});

		it("opens the printed /chat URL with tryOpen on --open", async () => {
			const { logs, opened } = await runStart({ ...flags, open: true });
			const printed = logs.at(-1) ?? "";
			expect(printed).toContain("/chat#_chat=");
			expect(opened).toEqual([printed]);
		});

		it("opens the --json URL on --open", async () => {
			const { logs, opened } = await runStart({
				...flags,
				json: true,
				open: true,
			});
			const payload = JSON.parse(logs.at(-1) ?? "{}") as { url: string };
			expect(opened).toEqual([payload.url]);
		});
	});

	it("opens the printed local URL with tryOpen on --open", async () => {
		const { logs, opened } = await runStart({ open: true });
		const printed = logs.at(-1) ?? "";
		expect(printed).toContain("/chat#_chat=");
		expect(opened).toEqual([printed]);
	});

	it("does not call tryOpen without --open, with or without --json", async () => {
		const plain = await runStart({});
		const json = await runStart({ json: true });
		expect(plain.opened).toEqual([]);
		expect(json.opened).toEqual([]);
	});

	it("carries the same chat URL in the --json url field", async () => {
		const { logs } = await runStart({ json: true });
		const payload = JSON.parse(logs.at(-1) ?? "{}") as { url: string };
		expect(payload.url.startsWith(`http://127.0.0.1:${port}/chat#_chat=`)).toBe(
			true,
		);
	});

	it("registers one new session per start through POST /start and never lists sessions", async () => {
		const requests: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(`${init?.method ?? "GET"} ${new URL(String(input instanceof Request ? input.url : input)).pathname}`);
			return realFetch(input, init);
		}) as typeof fetch;
		let first: string[];
		let second: string[];
		try {
			first = (await runStart({})).logs;
			second = (await runStart({})).logs;
		} finally {
			globalThis.fetch = realFetch;
		}

		expect(requests.filter((request) => request === "POST /start")).toHaveLength(2);
		expect(requests.filter((request) => request.endsWith("/sessions"))).toEqual([]);
		const ids = [first, second].map(
			(logs) => validateSessionBootstrap(decodeChatMarker(logs.at(-1) ?? "")).sessionId,
		);
		expect(new Set(ids).size).toBe(2);
	});

	it("opens the --json URL with --open", async () => {
		const { logs, opened } = await runStart({ json: true, open: true });
		const payload = JSON.parse(logs.at(-1) ?? "{}") as { url: string };

		expect(opened).toEqual([payload.url]);
	});

	it("succeeds when tryOpen reports no browser opened", async () => {
		const { logs } = await runStart({ open: true }, false);

		expect(logs.at(-1) ?? "").toContain("/chat#_chat=");
	});

	it("writes one stderr line when tryOpen reports no browser opened", async () => {
		const { errors } = await runStart({ open: true }, false);

		expect(errors).toContain("could not open a browser; open the URL above");
	});

	it("names the DG_OPEN_WINDOWS opt-in on WSL when no browser opened", async () => {
		const { errors } = await runStart({ open: true }, false, true);

		expect(errors).toContain(
			"could not open a browser; open the URL above (set DG_OPEN_WINDOWS=1 to open the Windows browser)",
		);
	});

	it("writes no could-not-open line when the browser opens", async () => {
		const { errors } = await runStart({ open: true });

		expect(errors).not.toContain("could not open a browser; open the URL above");
	});
});
