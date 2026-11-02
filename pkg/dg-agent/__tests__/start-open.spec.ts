import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths, writeSessionToken } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	decodeChatMarker,
	EXTENSION_ORIGIN,
	freshDgHome,
	killDaemonByPidFile,
} from "@dg/dg-daemon/test-harness";
import { writeConfig } from "../../dg-daemon/src/server/config-store";
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

async function runStart(options: StartOptions, tryOpenResult = true) {
	const opened: string[] = [];
	const seams: StartSeams = {
		daemonArgv: () => [process.execPath, DAEMON_ENTRY, "__serve"],
		tryOpen: async (url) => {
			opened.push(url);
			return tryOpenResult;
		},
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
		await withDgEnv(() => cmdStart({ fresh: true, ...options }, seams));
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
	return { logs, opened, errors };
}

async function createWaitingSession(): Promise<string> {
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	writeConfig(paths, { pinnedOrigin: EXTENSION_ORIGIN });
	const created = await fetch(`http://127.0.0.1:${port}/sessions`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			Origin: EXTENSION_ORIGIN,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ agentIdentity: "claude" }),
	});
	const { sessionId, token } = (await created.json()) as {
		sessionId: string;
		token: string;
	};
	writeSessionToken(paths, sessionId, {
		sessionId,
		token,
		cwd: process.cwd(),
		agentIdentity: "claude",
	});
	return sessionId;
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

	it("prints the extension /start URL with --ext", async () => {
		const { logs } = await runStart({ ext: true });
		const url = logs.at(-1) ?? "";
		expect(url.startsWith(`http://127.0.0.1:${port}/start#_chat=`)).toBe(true);
		expect(validateSessionBootstrap(decodeChatMarker(url)).port).toBe(port);
	});

	it("opens the printed local URL with tryOpen on --open", async () => {
		const { logs, opened } = await runStart({ open: true });
		const printed = logs.at(-1) ?? "";
		expect(printed).toContain("/chat#_chat=");
		expect(opened).toEqual([printed]);
	});

	it("opens the printed extension URL with tryOpen on --ext --open", async () => {
		const { logs, opened } = await runStart({ ext: true, open: true });
		const printed = logs.at(-1) ?? "";
		expect(printed).toContain("/start#_chat=");
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

	it("carries the /start URL in the --json url field with --ext", async () => {
		const { logs } = await runStart({ json: true, ext: true });
		const payload = JSON.parse(logs.at(-1) ?? "{}") as { url: string };
		expect(payload.url).toContain("/start#_chat=");
	});

	it("keeps one session in the chat and extension URLs of a claimed session", async () => {
		const sessionId = await createWaitingSession();

		const local = await runStart({ fresh: false, sessionId, open: true });
		const ext = await runStart({ fresh: false, sessionId, ext: true });
		const localUrl = local.logs.at(-1) ?? "";
		const localBootstrap = validateSessionBootstrap(decodeChatMarker(localUrl));

		expect(localUrl).toContain("/chat#_chat=");
		expect(local.opened).toEqual([localUrl]);
		expect(localBootstrap.sessionId).toBe(sessionId);
		expect(decodeChatMarker(ext.logs.at(-1) ?? "")).toEqual(localBootstrap);
	});

	it("opens the /start URL for a claimed session with --ext --open", async () => {
		const sessionId = await createWaitingSession();

		const { logs, opened } = await runStart({
			fresh: false,
			sessionId,
			ext: true,
			open: true,
		});
		const printed = logs.at(-1) ?? "";

		expect(printed).toContain("/start#_chat=");
		expect(opened).toEqual([printed]);
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

	it("writes no could-not-open line when the browser opens", async () => {
		const { errors } = await runStart({ open: true });

		expect(errors).not.toContain("could not open a browser; open the URL above");
	});
});
