import {
	CHAT_PROTOCOL_VERSION,
	CLI_SESSION_ID_HEADER,
	CLI_SESSION_TOKEN_HEADER,
} from "@dg/common";
import {
	resolveDgPaths,
	writePidFileAtomic,
	writeSessionToken,
} from "@dg/common/node";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeEnv } from "./module-call";

export const skillsEntry = join(import.meta.dir, "../src/index.ts");
export type CliResult = {
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
};

export function mailboxFixture(count = 3) {
	return {
		folders: [
			{
				id: "inbox",
				name: "Inbox",
				path: "Inbox",
				type: "system",
				total: count,
				unread: count,
			},
		],
		filters: [],
		messages: Array.from({ length: count }, (_, index) => ({
			id: `fixture-message-${index}`,
			from: "sender@example.test",
			subject: "Receipt for account 123456789",
			snippet: "Contact private@example.test about account 987654321.",
			folderId: "inbox",
			folderName: "Inbox",
			read: false,
		})),
	};
}

export function inboxCliHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "dg-inbox-cli-"));
	const dgHome = join(cwd, "dg-home");
	const workspace = join(cwd, "workspace");
	const dataPath = join(cwd, "fixture.json");
	const fixture = mailboxFixture();
	writeFileSync(dataPath, JSON.stringify(fixture));
	return {
		cwd,
		dgHome,
		workspace,
		dataPath,
		fixture,
		async run(
			args: string[],
			overrides: Record<string, string | undefined> = {},
			options: { executable?: string; timeoutMs?: number } = {},
		): Promise<CliResult> {
			const proc = Bun.spawn(
				options.executable
					? [options.executable, "inbox", ...args]
					: [process.execPath, skillsEntry, "inbox", ...args],
				{
					cwd,
					env: mergeEnv({
						DG_HOME: dgHome,
						DG_KEY_SOURCE: "file",
						DG_SESSION_TOKEN: undefined,
						GOOGLE_ACCESS_TOKEN: undefined,
						MS_ACCESS_TOKEN: undefined,
						...overrides,
					}),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			let timedOut = false;
			const timer = options.timeoutMs
				? setTimeout(() => {
						timedOut = true;
						proc.kill();
					}, options.timeoutMs)
				: undefined;
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (timer !== undefined) clearTimeout(timer);
			return {
				code,
				stdout,
				stderr,
				...(options.timeoutMs ? { timedOut } : {}),
			};
		},
		cleanup() {
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

export function inboxDaemonFixture(
	harness: ReturnType<typeof inboxCliHarness>,
	respond: (
		request: Record<string, unknown>,
		reply: (frame: Record<string, unknown>) => void,
	) => void,
) {
	const sessionId = "fixture-cli-session";
	const token = "fixture-cli-private-token";
	const requests: Record<string, unknown>[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (
				new URL(request.url).pathname !== "/cli" ||
				request.headers.get(CLI_SESSION_ID_HEADER) !== sessionId ||
				request.headers.get(CLI_SESSION_TOKEN_HEADER) !== token
			)
				return new Response("unauthorized", { status: 401 });
			if (server.upgrade(request)) return;
			return new Response("upgrade required", { status: 400 });
		},
		websocket: {
			message(socket, message) {
				const request = JSON.parse(String(message)) as Record<string, unknown>;
				requests.push(request);
				respond(request, (frame) => socket.send(JSON.stringify(frame)));
			},
		},
	});
	const paths = resolveDgPaths({ env: { DG_HOME: harness.dgHome } });
	writePidFileAtomic(paths, {
		pid: process.pid,
		port: server.port!,
		instanceId: "fixture-inbox-daemon",
		versions: { package: "1.0.0", protocol: CHAT_PROTOCOL_VERSION },
	});
	writeSessionToken(paths, sessionId, {
		sessionId,
		token,
		cwd: harness.cwd,
		agentIdentity: "fixture-model",
	});
	return { sessionId, token, requests, stop: () => server.stop(true) };
}
