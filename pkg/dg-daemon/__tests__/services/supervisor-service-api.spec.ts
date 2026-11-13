import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { disposeRigs, type Rig, rig, SLEEPER, until } from "./supervisor-kit";

afterEach(disposeRigs);

const DAEMON_URL = "http://127.0.0.1:43210";
const TOKEN = "fixture-grant-token-9c41d7e2";
const GRANT_KEYS = ["DG_CREDENTIAL_GRANT_PREFIX", "DG_CREDENTIAL_GRANT_FILE"];

function grantsDirOf(root: string): string {
	return join(root, "grants");
}

function writeToken(root: string, prefix = "bot", token = TOKEN): string {
	mkdirSync(grantsDirOf(root), { recursive: true });
	const path = join(grantsDirOf(root), `${prefix}.token`);
	writeFileSync(path, token, { mode: 0o600 });
	return path;
}

function writeEnvFile(root: string, content: string): string {
	const path = join(root, "secrets.env");
	writeFileSync(path, content, { mode: 0o600 });
	return path;
}

async function withDaemonEnv<T>(
	vars: Record<string, string>,
	run: () => Promise<T>,
): Promise<T> {
	const saved = Object.keys(vars).map(
		(key) => [key, process.env[key]] as const,
	);
	for (const [key, value] of Object.entries(vars)) process.env[key] = value;
	try {
		return await run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function dumpedEnv(
	extra: Record<string, unknown>,
	options: {
		token?: boolean;
		prepare?: (root: string) => Record<string, unknown>;
	} = {},
): Promise<{ env: Record<string, string>; rig: Rig; tokenPath?: string }> {
	let dump = "";
	const r = rig(
		({ root, script }) => {
			dump = join(root, "env.json");
			return {
				bot: {
					argv: script(
						`require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env)); ${SLEEPER}`,
					),
					cwd: root,
					...(options.prepare?.(root) ?? {}),
					...extra,
				},
			};
		},
		25,
		{ daemonUrl: () => DAEMON_URL },
	);
	const tokenPath = options.token ? writeToken(r.root) : undefined;
	const started = r.supervisor.start("bot");
	expect(started.ok).toBe(true);
	await until(() => existsSync(dump));
	return { env: JSON.parse(readFileSync(dump, "utf8")), rig: r, tokenPath };
}

describe("supervisor service API environment", () => {
	it("gives a service without grant the three keys and neither grant key", async () => {
		const { env } = await dumpedEnv({});
		expect(env.DG_SERVICE_API).toBe("1");
		expect(env.DG_SERVICE_LABEL).toBe("bot");
		expect(env.DG_DAEMON_URL).toBe(DAEMON_URL);
		for (const key of GRANT_KEYS) expect(env[key]).toBeUndefined();
	});

	it("gives a service with grant the five keys and no token value", async () => {
		const { env, tokenPath } = await dumpedEnv(
			{ grant: "bot" },
			{ token: true },
		);
		expect(env.DG_SERVICE_API).toBe("1");
		expect(env.DG_SERVICE_LABEL).toBe("bot");
		expect(env.DG_DAEMON_URL).toBe(DAEMON_URL);
		expect(env.DG_CREDENTIAL_GRANT_PREFIX).toBe("bot");
		expect(env.DG_CREDENTIAL_GRANT_FILE).toBe(tokenPath as string);
		expect(env.DG_CREDENTIAL_GRANT_FILE.startsWith("/")).toBe(true);
		for (const value of Object.values(env)) expect(value).not.toBe(TOKEN);
		expect(JSON.stringify(env)).not.toContain(TOKEN);
	});

	it("removes the grant keys for a service without grant even when passEnv names them", async () => {
		const { env } = await withDaemonEnv(
			{
				DG_CREDENTIAL_GRANT_FILE: "/tmp/leaked.token",
				DG_CREDENTIAL_GRANT_PREFIX: "leaked",
			},
			() => dumpedEnv({ passEnv: GRANT_KEYS }),
		);
		for (const key of GRANT_KEYS) expect(env[key]).toBeUndefined();
	});

	it("lets the injected keys win over envFile and passEnv", async () => {
		const envFileLines = [
			"DG_SERVICE_LABEL=other",
			"DG_SERVICE_API=0",
			"DG_DAEMON_URL=http://evil.example",
			"DG_CREDENTIAL_GRANT_PREFIX=other",
			"DG_CREDENTIAL_GRANT_FILE=/etc/passwd",
		];
		const { env, tokenPath } = await withDaemonEnv(
			{ DG_SERVICE_LABEL: "from-daemon" },
			() =>
				dumpedEnv(
					{ grant: "bot", passEnv: ["DG_SERVICE_LABEL"] },
					{
						token: true,
						prepare: (root) => ({
							envFile: writeEnvFile(root, envFileLines.join("\n")),
						}),
					},
				),
		);
		expect(env.DG_SERVICE_LABEL).toBe("bot");
		expect(env.DG_SERVICE_API).toBe("1");
		expect(env.DG_DAEMON_URL).toBe(DAEMON_URL);
		expect(env.DG_CREDENTIAL_GRANT_PREFIX).toBe("bot");
		expect(env.DG_CREDENTIAL_GRANT_FILE).toBe(tokenPath as string);
	});

	it("keeps a grant-less service free of an envFile grant file", async () => {
		const { env } = await dumpedEnv(
			{},
			{
				prepare: (root) => ({
					envFile: writeEnvFile(root, "DG_CREDENTIAL_GRANT_FILE=/etc/passwd\n"),
				}),
			},
		);
		expect(env.DG_CREDENTIAL_GRANT_FILE).toBeUndefined();
	});
});

describe("supervisor grant token preflight", () => {
	function grantedRig(): Rig {
		return rig(
			({ root, script }) => ({
				bot: { argv: script(SLEEPER), cwd: root, grant: "bot" },
			}),
			25,
			{ daemonUrl: () => DAEMON_URL },
		);
	}

	const missingText = (path: string) =>
		`grant token file not found: ${path} — create it with dg-skills credentials grant bot`;

	it("refuses to start a declared grant with no token file and starts no process", () => {
		const r = grantedRig();
		const path = join(grantsDirOf(r.root), "bot.token");
		const result = r.supervisor.start("bot");
		expect(result).toEqual({
			ok: false,
			kind: "invalid",
			error: missingText(path),
		});
		expect(existsSync(r.logFile)).toBe(false);
		expect(r.status().state).toBe("stopped");
	});

	it("refuses a token path that is a directory with the same text", () => {
		const r = grantedRig();
		const path = join(grantsDirOf(r.root), "bot.token");
		mkdirSync(path, { recursive: true });
		const result = r.supervisor.start("bot");
		expect(result).toEqual({
			ok: false,
			kind: "invalid",
			error: missingText(path),
		});
	});

	it("starts once the token file exists, without reading the token", async () => {
		const r = grantedRig();
		writeToken(r.root, "bot", "");
		expect(r.supervisor.start("bot").ok).toBe(true);
		await until(() => r.status().state === "running");
	});

	it("fails the next start after the token file is removed", async () => {
		const r = grantedRig();
		const path = writeToken(r.root);
		expect(r.supervisor.start("bot").ok).toBe(true);
		await r.supervisor.stop("bot");
		rmSync(path);
		const second = r.supervisor.start("bot");
		expect(second.ok).toBe(false);
		expect(second.ok === false && second.error).toBe(missingText(path));
	});

	it("starts a service without grant when no token file exists", async () => {
		const r = rig(({ root, script }) => ({
			bot: { argv: script(SLEEPER), cwd: root },
		}));
		expect(r.supervisor.start("bot").ok).toBe(true);
	});
});
