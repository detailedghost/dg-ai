import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	PW_EXT_MIN_EXTENSION_VERSION,
	PW_EXT_READ_VERBS,
	PW_EXT_WRITE_VERBS,
} from "@dg/common";
import {
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	frameType,
	killDaemonByPidFile,
	send,
	startWithSession,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";

const MARKER = "fake-marker-value-for-tests";
const sockets: WebSocket[] = [];
let dgHome: string | undefined;

afterEach(() => {
	closeSockets(sockets);
	if (dgHome) {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	}
	dgHome = undefined;
});

type Frame = Record<string, unknown>;

async function boot() {
	const started = await startWithSession();
	dgHome = started.dgHome;
	const cli = await connectCli(started.port, started.bootstrap);
	sockets.push(cli);
	const socket = wsExtensionSocket(started.port);
	sockets.push(socket);
	const extensionFrames = collectFrames(socket);
	await waitForOpen(socket);
	send(socket, {
		type: "connect",
		...started.bootstrap,
		extensionVersion: PW_EXT_MIN_EXTENSION_VERSION.join("."),
		pwExtVerbs: [...PW_EXT_READ_VERBS, ...PW_EXT_WRITE_VERBS],
	});
	await waitForValue(
		() => extensionFrames.find((frame) => frameType(frame) === "session-list"),
		700,
		"extension handshake",
	);
	return { ...started, cli, cliFrames: collectFrames(cli), socket, extensionFrames };
}

function storeFrame(credentials: { sessionId: string; token: string }, overrides: Frame = {}) {
	return {
		type: "pw-ext-credential-store",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		sessionId: credentials.sessionId,
		token: credentials.token,
		requestId: randomUUID(),
		site: "live.com",
		name: "owa-token",
		value: MARKER,
		meta: { site: "https://outlook.live.com", source: "header:authorization", createdBy: "pw --ext credential save" },
		...overrides,
	};
}

function find(frames: unknown[], type: string, requestId: string) {
	return waitForValue(
		() => frames.find((raw) => (raw as Frame).type === type && (raw as Frame).requestId === requestId) as Frame | undefined,
		1500,
		`${type} ${requestId}`,
	);
}

async function credentials(cli: WebSocket, frames: unknown[], operation: "list" | "get", name?: string) {
	const requestId = randomUUID();
	send(cli, { type: "cli-credentials-request", requestId, operation, ...(name ? { name } : {}) });
	return find(frames, "cli-credentials-result", requestId);
}

function allow(lines: string[]) {
	const dir = join(dgHome as string, "config");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "exec-allowlist"), `${lines.join("\n")}\n`);
}

function script(body: string): string {
	const dir = join(dgHome as string, "tools");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "show-token");
	writeFileSync(path, `#!${process.execPath}\n${body}\n`);
	chmodSync(path, 0o755);
	return realpathSync(path);
}

function execFrame(argv: string[], name = "pw/live.com/owa-token") {
	return {
		type: "cli-credentials-request",
		requestId: randomUUID(),
		operation: "exec",
		exec: { bindings: [{ name, env: "TOKEN" }], argv, cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" } },
	};
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

describe("pw --ext credential save through the daemon", () => {
	it("runs CLI to daemon to extension and back, and the value reaches only the encrypted store", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		const requestId = randomUUID();
		send(cli, {
			type: "cli-pw-ext-request",
			requestId,
			request: { verb: "credential", name: "owa-token", source: "header", key: "authorization" },
			timeoutMs: 3000,
		});
		const relayed = await find(extensionFrames, "pw-ext-browser-request", requestId);
		expect(relayed.request).toEqual({ verb: "credential", name: "owa-token", source: "header", key: "authorization" });

		const store = storeFrame(bootstrap);
		send(socket, store);
		const stored = await find(extensionFrames, "pw-ext-credential-stored", store.requestId);
		expect(stored).toMatchObject({ ok: true, name: "pw/live.com/owa-token" });

		send(socket, {
			type: "pw-ext-browser-result",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			requestId,
			ok: true,
			data: { text: "### Result\nSaved pw/live.com/owa-token from the header authorization." },
		});
		const done = await find(cliFrames, "cli-pw-ext-result", requestId);
		expect(done).toMatchObject({ ok: true });

		const listed = await credentials(cli, cliFrames, "list");
		expect(JSON.stringify(listed)).toContain("pw/live.com/owa-token");
		const got = await credentials(cli, cliFrames, "get", "pw/live.com/owa-token");
		expect(got).toMatchObject({ ok: false, error: expect.stringContaining("never returned") });

		expect(JSON.stringify(cliFrames)).not.toContain(MARKER);
		expect(JSON.stringify(extensionFrames)).not.toContain(MARKER);
		for (const file of filesUnder(dgHome as string))
			expect(readFileSync(file).includes(Buffer.from(MARKER))).toBe(false);
	});

	it("refuses the store frame from a CLI socket, with a bad token, and for a bad name", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		send(cli, storeFrame(bootstrap));
		send(socket, storeFrame({ sessionId: bootstrap.sessionId, token: "wrong-token" }));
		const badName = storeFrame(bootstrap, { name: "../x" });
		send(socket, badName);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const listed = await credentials(cli, cliFrames, "list");
		expect(JSON.stringify(listed)).not.toContain("pw/");
		expect(JSON.stringify([...cliFrames, ...extensionFrames])).not.toContain(MARKER);
	});

	it("runs exec in the daemon: the child gets the value, and every frame to the CLI is scrubbed", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		const store = storeFrame(bootstrap);
		send(socket, store);
		await find(extensionFrames, "pw-ext-credential-stored", store.requestId);
		const source = [
			"const v = process.env.TOKEN;",
			"const forms = [v, Buffer.from(v).toString('base64'), Buffer.from(v).toString('base64url'), encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2)];",
			"process.stdout.write('len=' + v.length + ' ' + forms.join(' ') + ' ' + v.slice(0, 9));",
			"await Bun.sleep(30);",
			"process.stdout.write(v.slice(9) + '\\n');",
			"process.stderr.write('err ' + v + '\\n');",
			"process.exit(7);",
		].join("\n");
		const tool = script(source);
		allow([`${tool} pw/live.com/*`]);
		const frame = execFrame([tool]);
		const requestId = frame.requestId;
		send(cli, frame);
		const done = await waitForValue(
			() => cliFrames.find((raw) => (raw as Frame).type === "cli-credentials-result" && (raw as Frame).requestId === requestId) as Frame | undefined,
			10_000,
			"exec result",
		);
		expect(done).toMatchObject({ ok: true, value: { exitCode: 7 } });
		const output = cliFrames
			.filter((raw) => (raw as Frame).type === "cli-credentials-exec-output" && (raw as Frame).requestId === requestId)
			.map((raw) => `${(raw as Frame).stream}:${(raw as Frame).data}`)
			.join("");
		expect(output).toContain(`len=${MARKER.length}`);
		expect(output).toContain("[redacted]");
		for (const form of [MARKER, Buffer.from(MARKER).toString("base64"), Buffer.from(MARKER).toString("base64url"), encodeURIComponent(MARKER)])
			expect(JSON.stringify(cliFrames)).not.toContain(form);
	});

	it("kills the whole process group when the CLI disconnects", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		const store = storeFrame(bootstrap);
		send(socket, store);
		await find(extensionFrames, "pw-ext-credential-stored", store.requestId);
		allow([`${realpathSync(Bun.which("sh") as string)} allow-interpreter`]);
		const frame = execFrame(["sh", "-c", "sleep 30 & echo $!; wait"]);
		const requestId = frame.requestId;
		send(cli, frame);
		const line = await waitForValue(
			() => cliFrames.find((raw) => (raw as Frame).type === "cli-credentials-exec-output" && (raw as Frame).requestId === requestId) as Frame | undefined,
			5000,
			"background pid",
		);
		const pid = Number(String(line.data).trim());
		expect(Number.isInteger(pid)).toBe(true);
		cli.close();
		await waitForValue(
			() => {
				try {
					process.kill(pid, 0);
					return undefined;
				} catch {
					return true;
				}
			},
			5000,
			"background job ended",
		);
	});

	it("refuses exec of pw/ values with no allowlist, when not listed, and for a listed shell, with no value in any frame", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		const store = storeFrame(bootstrap);
		send(socket, store);
		await find(extensionFrames, "pw-ext-credential-stored", store.requestId);
		const tool = script("console.log(process.env.TOKEN)");
		const shell = realpathSync(Bun.which("sh") as string);
		const attempts: [string[] | undefined, string[], string][] = [
			[undefined, [tool], "does not exist"],
			[["/usr/bin/true"], [tool], "is not listed"],
			[[shell], ["sh", "-c", "echo $TOKEN"], "shell or interpreter"],
		];
		for (const [lines, argv, message] of attempts) {
			if (lines) allow(lines);
			const frame = execFrame(argv);
			send(cli, frame);
			const answer = await find(cliFrames, "cli-credentials-result", frame.requestId);
			expect(answer.ok).toBe(false);
			expect(String(answer.error)).toContain(message);
		}
		expect(cliFrames.some((raw) => (raw as Frame).type === "cli-credentials-exec-output")).toBe(false);
		expect(JSON.stringify(cliFrames)).not.toContain(MARKER);
	});

	it("runs a listed command through a symlink and leaves names outside pw/ unchanged", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		const store = storeFrame(bootstrap);
		send(socket, store);
		await find(extensionFrames, "pw-ext-credential-stored", store.requestId);
		const tool = script("console.log('got ' + process.env.TOKEN.length)");
		allow([tool]);
		const link = join(dgHome as string, "tools", "link");
		symlinkSync(tool, link);
		const frame = execFrame([link]);
		send(cli, frame);
		expect(await find(cliFrames, "cli-credentials-result", frame.requestId)).toMatchObject({ ok: true, value: { exitCode: 0 } });
		const out = cliFrames.filter((raw) => (raw as Frame).type === "cli-credentials-exec-output").map((raw) => (raw as Frame).data).join("");
		expect(out).toContain(`got ${MARKER.length}`);
		const setId = randomUUID();
		send(cli, { type: "cli-credentials-request", requestId: setId, operation: "set", name: "tools/plain", value: "plain-fake-value", meta: {} });
		await find(cliFrames, "cli-credentials-result", setId);
		const plain = execFrame(["true"], "tools/plain");
		send(cli, plain);
		expect(await find(cliFrames, "cli-credentials-result", plain.requestId)).toMatchObject({ ok: true });
	});

	it("refuses exec for a value too short to scrub", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		const store = storeFrame(bootstrap, { name: "short", value: "abc" });
		send(socket, store);
		await find(extensionFrames, "pw-ext-credential-stored", store.requestId);
		const requestId = randomUUID();
		send(cli, {
			type: "cli-credentials-request",
			requestId,
			operation: "exec",
			exec: { bindings: [{ name: "pw/live.com/short", env: "X" }], argv: ["sh", "-c", "echo $X"], cwd: process.cwd(), env: {} },
		});
		expect(await find(cliFrames, "cli-credentials-result", requestId)).toMatchObject({ ok: false, error: expect.stringContaining("shorter than 4") });
		expect(cliFrames.some((raw) => (raw as Frame).type === "cli-credentials-exec-output")).toBe(false);
	});

	it("refuses exec from the extension socket and for a missing name, with no value", async () => {
		const { cli, cliFrames, socket, extensionFrames } = await boot();
		const exec = (name: string) => ({
			type: "cli-credentials-request",
			requestId: randomUUID(),
			operation: "exec",
			exec: { bindings: [{ name, env: "X" }], argv: ["true"], cwd: process.cwd(), env: {} },
		});
		const fromExtension = exec("pw/live.com/owa-token");
		send(socket, fromExtension);
		expect(await find(extensionFrames, "cli-credentials-result", fromExtension.requestId)).toMatchObject({ ok: false });
		const missing = exec("pw/live.com/none");
		send(cli, missing);
		expect(await find(cliFrames, "cli-credentials-result", missing.requestId)).toMatchObject({
			ok: false,
			error: "No credential named pw/live.com/none.",
		});
	});

	it("does not let the extension read a saved value back", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		const store = storeFrame(bootstrap);
		send(socket, store);
		await find(extensionFrames, "pw-ext-credential-stored", store.requestId);
		const requestId = randomUUID();
		send(socket, { type: "cli-credentials-request", requestId, operation: "get", name: "pw/live.com/owa-token" });
		const answer = await find(extensionFrames, "cli-credentials-result", requestId);
		expect(answer.ok).toBe(false);
		expect(JSON.stringify(extensionFrames)).not.toContain(MARKER);
		expect(JSON.stringify(await credentials(cli, cliFrames, "list"))).toContain("pw/live.com/owa-token");
	});
});
