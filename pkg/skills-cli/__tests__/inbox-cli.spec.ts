import { CliClient } from "@dg/dg-agent/client";
import type { InboxCliResult } from "@dg/common";
import { redactPublicValue } from "@dg/inbox";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	bootServe,
	cleanupDgHome,
	connectPage,
	recvMessage,
	registerSession,
	send,
	stopServe,
} from "@dg/dg-daemon/test-harness";
import {
	inboxCliHarness,
	inboxDaemonFixture,
	mailboxFixture,
	skillsEntry,
} from "./inbox-cli-harness";

const providers = ["protonmail", "gmail", "outlook"] as const;

describe("dg-skills inbox", () => {
	test("shows inbox workflow help without requiring a daemon or account", async () => {
		const h = inboxCliHarness();
		try {
			const result = await h.run(["--help"]);
			expect(result.code, result.stderr).toBe(0);
			for (const word of [...providers, "profile", "probe", "batch"])
				expect(result.stdout).toContain(word);
		} finally {
			h.cleanup();
		}
	});

	for (const provider of providers)
		test(`${provider} fixture batches from an unrelated cwd without live authentication`, async () => {
			const h = inboxCliHarness();
			const args = [
				"--provider",
				provider,
				"--dir",
				h.workspace,
				"--data-path",
				h.dataPath,
			];
			try {
				const loaded = await h.run(["load", "folders", ...args]);
				expect(loaded.code, loaded.stderr).toBe(0);
				expect(JSON.parse(loaded.stdout)).toMatchObject({
					kind: "workspace-load-folders",
					provider,
					count: h.fixture.folders.length,
				});
				const batch = await h.run([
					"batch",
					"--folder",
					"Inbox",
					"--limit",
					String(h.fixture.messages.length),
					...args,
				]);
				expect(batch.code, batch.stderr).toBe(0);
				expect(JSON.parse(batch.stdout)).toMatchObject({
					kind: "workspace-batch",
					total: h.fixture.messages.length,
				});
				const status = JSON.parse(
					readFileSync(join(h.workspace, "messages/_status.json"), "utf8"),
				);
				expect(status.total).toBe(h.fixture.messages.length);
				const packets = status.items
					.map((item: { file: string }) =>
						readFileSync(join(h.workspace, item.file), "utf8"),
					)
					.join("\n");
				for (const value of [
					"sender@example.test",
					"private@example.test",
					"123456789",
					"987654321",
				]) {
					expect(batch.stdout).not.toContain(value);
					expect(packets).not.toContain(value);
				}
			} finally {
				h.cleanup();
			}
		});

	test("refuses mutation without confirmation and confirmed apply without a dry run", async () => {
		const h = inboxCliHarness();
		const args = [
			"--provider",
			"protonmail",
			"--dir",
			h.workspace,
			"--data-path",
			h.dataPath,
		];
		try {
			const load = await h.run(["load", "folders", ...args]);
			expect(load.code, load.stderr).toBe(0);
			const batch = await h.run(["batch", "--folder", "Inbox", ...args]);
			expect(batch.code, batch.stderr).toBe(0);
			const original = readFileSync(h.dataPath, "utf8");
			const unconfirmed = await h.run(["apply", ...args]);
			expect(unconfirmed.code).not.toBe(0);
			expect(unconfirmed.stderr).toMatch(/requires --dry-run or --confirm/);
			const confirmed = await h.run(["apply", "--confirm", ...args]);
			expect(confirmed.code).not.toBe(0);
			expect(confirmed.stderr).toMatch(/requires a successful apply --dry-run/);
			expect(readFileSync(h.dataPath, "utf8")).toBe(original);
		} finally {
			h.cleanup();
		}
	});

	test("profile setup reports a missing daemon with concrete session setup guidance", async () => {
		const h = inboxCliHarness();
		try {
			const result = await h.run([
				"profile",
				"set",
				"personal",
				"--json",
				JSON.stringify({
					provider: "gmail",
					gmail: { clientId: "fixture-client" },
				}),
			]);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toMatch(/daemon|session/i);
			expect(result.stderr).toMatch(
				/dg-agent start|dg-skills install|start a.+session/i,
			);
		} finally {
			h.cleanup();
		}
	});
});

describe("dg-skills inbox daemon integration", () => {
	test("saves helpful Gmail and Outlook settings and lists profiles as model-readable JSON", async () => {
		const h = inboxCliHarness();
		const daemon = await bootServe();
		try {
			const bootstrap = await registerSession(daemon.port, { cwd: h.cwd });
			const env = { DG_HOME: daemon.dgHome };
			const profile = {
				provider: "gmail",
				gmail: {
					clientId: "fixture-client",
					authMode: "browser",
					pageSize: 41,
					clientSecretEnv: "TEST_GMAIL_SECRET",
				},
			};
			const saved = await h.run(
				[
					"profile",
					"set",
					"personal",
					"--json",
					JSON.stringify(profile),
					"--session",
					bootstrap.sessionId,
				],
				env,
			);
			expect(saved.code, saved.stderr).toBe(0);
			expect(() => JSON.parse(saved.stdout)).not.toThrow();
			const fetched = await h.run(
				["--session", bootstrap.sessionId, "profile", "get", "personal"],
				env,
			);
			expect(fetched.code, fetched.stderr).toBe(0);
			expect(fetched.stdout).toContain(profile.gmail.clientId);
			expect(fetched.stdout).toContain(profile.gmail.clientSecretEnv);
			expect(JSON.stringify(JSON.parse(fetched.stdout))).toContain("41");
			const outlook = {
				provider: "outlook",
				outlook: {
					clientId: "outlook-fixture",
					tenantId: "organizations",
					authMode: "device-code",
					scopes: ["Mail.ReadWrite"],
					pageSize: 47,
				},
			};
			const file = join(h.cwd, "profile.json");
			await Bun.write(file, JSON.stringify(outlook));
			const stored = await h.run(
				[
					"profile",
					"set",
					"work",
					"--file",
					file,
					"--session",
					bootstrap.sessionId,
				],
				env,
			);
			expect(stored.code, stored.stderr).toBe(0);
			const listed = await h.run(
				["profile", "list", "--session", bootstrap.sessionId],
				env,
			);
			expect(listed.code, listed.stderr).toBe(0);
			const output = JSON.stringify(JSON.parse(listed.stdout));
			for (const value of ["personal", "work", "gmail", "outlook"])
				expect(output).toContain(value);
			const forbidden = await h.run(
				["profile", "cache-get", "personal", "--session", bootstrap.sessionId],
				env,
			);
			expect(forbidden.code).not.toBe(0);
		} finally {
			await stopServe(daemon.proc);
			cleanupDgHome(daemon.dgHome);
			h.cleanup();
		}
	}, 20_000);

	test("returns Proton extension metadata directly as redacted CLI JSON without adding a chat message", async () => {
		const h = inboxCliHarness();
		const daemon = await bootServe();
		let page: WebSocket | undefined;
		try {
			const bootstrap = await registerSession(daemon.port, { cwd: h.cwd });
			page = await connectPage(daemon.port, bootstrap, undefined, "1.10.0");
			const fixture = mailboxFixture();
			const requests: Record<string, unknown>[] = [];
			page.addEventListener("message", (event) => {
				const frame = JSON.parse(String(event.data));
				if (frame.type !== "inbox-browser-request") return;
				requests.push(frame);
				const operation = frame.request.operation;
				const data =
					operation === "list-folders"
						? { folders: fixture.folders }
						: operation === "list-messages"
							? { messages: fixture.messages, hasMore: false }
							: { filters: fixture.filters };
				send(page!, {
					type: "inbox-browser-result",
					sessionId: bootstrap.sessionId,
					token: bootstrap.token,
					requestId: frame.requestId,
					ok: true,
					data,
				});
			});
			const args = [
				"--provider",
				"protonmail",
				"--dir",
				h.workspace,
				"--session",
				bootstrap.sessionId,
			];
			const loaded = await h.run(["load", "folders", ...args], {
				DG_HOME: daemon.dgHome,
			});
			expect(loaded.code, loaded.stderr).toBe(0);
			const probe = await h.run(
				[
					"probe",
					"--folder",
					"Inbox",
					"--limit",
					String(fixture.messages.length),
					...args,
				],
				{ DG_HOME: daemon.dgHome },
			);
			expect(probe.code, probe.stderr).toBe(0);
			expect(JSON.parse(probe.stdout)).toMatchObject({
				kind: "workspace-probe",
				fetched: fixture.messages.length,
				mutated: false,
			});
			expect(
				requests.some(
					(frame) =>
						(frame.request as { operation: string }).operation ===
						"list-messages",
				),
			).toBe(true);
			for (const frame of requests)
				expect(frame.sessionId).toBe(bootstrap.sessionId);
			for (const secret of [
				bootstrap.token,
				"sender@example.test",
				"private@example.test",
				"123456789",
				"987654321",
			])
				expect(probe.stdout).not.toContain(secret);
			expect(
				await recvMessage(daemon.dgHome, daemon.port, bootstrap.sessionId),
			).toMatchObject({ outcome: "empty" });
		} finally {
			page?.close();
			await stopServe(daemon.proc);
			cleanupDgHome(daemon.dgHome);
			h.cleanup();
		}
	}, 20_000);
});

describe("dg-skills inbox daemon response boundary", () => {
	test("fails immediately with install and restart guidance when an older daemon rejects the inbox protocol", async () => {
		const h = inboxCliHarness();
		const server = inboxDaemonFixture(h, (_request, reply) =>
			reply({
				type: "error",
				sessionId: "fixture-cli-session",
				protocolVersion: 1,
				message:
					"Unknown inbox frame private@example.test token=private-old-daemon-detail",
			}),
		);
		try {
			const result = await h.run(
				["profile", "get", "personal", "--session", server.sessionId],
				{},
				{ timeoutMs: 4000 },
			);
			expect(server.requests).toHaveLength(1);
			expect(result.timedOut).toBe(false);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toMatch(/dg-skills install/);
			expect(result.stderr).toMatch(/restart|stop.+daemon/i);
			for (const secret of [
				server.token,
				"private@example.test",
				"private-old-daemon-detail",
			])
				expect(result.stderr).not.toContain(secret);
		} finally {
			server.stop();
			h.cleanup();
		}
	}, 6000);

	test("ignores wrong request, wrong session, and other-session errors until the exact correlated daemon result", async () => {
		const h = inboxCliHarness();
		const matching = {
			provider: "gmail",
			gmail: { clientId: "matching-profile", pageSize: 47 },
		};
		const server = inboxDaemonFixture(h, (request, reply) => {
			const result = {
				type: "cli-inbox-result",
				sessionId: "fixture-cli-session",
				protocolVersion: 1,
				requestId: request.requestId,
				ok: true,
				value: matching,
			};
			reply({
				...result,
				sessionId: "unrelated-session",
				value: { provider: "gmail", gmail: { clientId: "wrong-session" } },
			});
			reply({
				...result,
				requestId: "unrelated-request",
				value: { provider: "gmail", gmail: { clientId: "wrong-request" } },
			});
			reply({
				type: "error",
				sessionId: "unrelated-session",
				protocolVersion: 1,
				message: "wrong-session-error",
			});
			setTimeout(() => reply(result), 20);
		});
		try {
			const result = await h.run(
				["--session=" + server.sessionId, "profile", "get", "personal"],
				{},
				{ timeoutMs: 4000 },
			);
			expect(result.timedOut).toBe(false);
			expect(result.code, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				kind: "inbox-profile",
				name: "personal",
				profile: matching,
			});
			expect(server.requests).toEqual([
				expect.objectContaining({
					type: "cli-inbox-request",
					operation: "profile-get",
					name: "personal",
					requestId: expect.any(String),
				}),
			]);
			for (const value of ["wrong-session", "wrong-request", server.token])
				expect(result.stdout).not.toContain(value);
		} finally {
			server.stop();
			h.cleanup();
		}
	}, 6000);

	test.each(
		[
			[
				"profile",
				"set",
				"personal",
				"--json",
				'{"provider":"gmail","gmail":{"clientId":"test","clientSecret":"inline-private-secret"}}',
			],
			[
				"profile",
				"set",
				"personal",
				"--provider",
				"gmail",
				"--client-secret",
				"inline-private-secret",
			],
			[
				"profile",
				"set",
				"personal",
				"--provider",
				"protonmail",
				"--client-id",
				"invalid-proton-client",
			],
			["profile", "set", "personal", "--provider", "gmail", "--page-size", "0"],
			["profile", "list", "--session", "first", "--session", "second"],
		].map((args) => ({ args })),
	)(
		"validates profile settings and session flags before any daemon request %j",
		async ({ args }) => {
			const h = inboxCliHarness();
			try {
				const result = await h.run(args);
				expect(result.code).not.toBe(0);
				expect(result.stderr).not.toContain("inline-private-secret");
				expect(result.stderr).not.toMatch(/requires a dg daemon session/);
			} finally {
				h.cleanup();
			}
		},
	);
});

describe("compiled dg-skills inbox", () => {
	test("runs real help and all three fixture workflows from an unrelated cwd with no Bun on PATH", async () => {
		const build = inboxCliHarness();
		const executable = join(build.cwd, "dg-skills");
		try {
			const compile = Bun.spawn(
				[
					process.execPath,
					"build",
					skillsEntry,
					"--compile",
					"--outfile",
					executable,
				],
				{ cwd: build.cwd, stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(compile.stdout).text(),
				new Response(compile.stderr).text(),
				compile.exited,
			]);
			expect(code, stdout + stderr).toBe(0);
			const help = await build.run(
				["--help"],
				{ PATH: "" },
				{ executable, timeoutMs: 4000 },
			);
			expect(help.code, help.stderr).toBe(0);
			for (const provider of providers) expect(help.stdout).toContain(provider);
			for (const legacy of ["Playwright", "--playwright"])
				expect(help.stdout).not.toContain(legacy);
			expect(help.stdout).toContain(
				"Use a signed-in extension-enabled mail tab",
			);
			expect(help.stdout).toContain(
				"Legacy browser options store metadata; they do not launch a browser.",
			);
			for (const provider of providers) {
				const h = inboxCliHarness();
				try {
					const args = [
						"--provider",
						provider,
						"--dir",
						h.workspace,
						"--data-path",
						h.dataPath,
					];
					const loaded = await h.run(
						["load", "folders", ...args],
						{ PATH: "" },
						{ executable, timeoutMs: 4000 },
					);
					expect(loaded.code, loaded.stderr).toBe(0);
					expect(JSON.parse(loaded.stdout)).toMatchObject({
						provider,
						count: h.fixture.folders.length,
					});
					const batch = await h.run(
						["batch", "--folder", "Inbox", "--limit", "3", ...args],
						{ PATH: "" },
						{ executable, timeoutMs: 4000 },
					);
					expect(batch.code, batch.stderr).toBe(0);
					expect(JSON.parse(batch.stdout)).toMatchObject({
						kind: "workspace-batch",
						total: h.fixture.messages.length,
					});
					expect(
						JSON.parse(
							readFileSync(join(h.workspace, "messages/_status.json"), "utf8"),
						).total,
					).toBe(h.fixture.messages.length);
				} finally {
					h.cleanup();
				}
			}
		} finally {
			build.cleanup();
		}
	}, 30_000);
});

test("dg-skills inbox profile flags store exact helpful Outlook configuration while redacting only public output", async () => {
	const h = inboxCliHarness();
	const daemon = await bootServe();
	let client: CliClient | undefined;
	const profile = {
		provider: "outlook",
		outlook: {
			clientId: "outlook-granular-client",
			tenantId: "organizations",
			authority: "https://login.microsoftonline.com",
			authMode: "device-code",
			scopes: ["Mail.ReadWrite", "offline_access"],
			pageSize: 47,
			clientSecretEnv: "TEST_OUTLOOK_CLIENT_SECRET",
			loginHint: "private@example.test",
		},
	};
	try {
		const bootstrap = await registerSession(daemon.port, { cwd: h.cwd });
		const saved = await h.run(
			[
				"profile",
				"set",
				"work",
				"--provider",
				profile.provider,
				"--client-id",
				profile.outlook.clientId,
				"--tenant-id",
				profile.outlook.tenantId,
				"--authority",
				profile.outlook.authority,
				"--auth-mode",
				profile.outlook.authMode,
				"--scopes",
				profile.outlook.scopes.join(","),
				"--page-size",
				String(profile.outlook.pageSize),
				"--client-secret-env",
				profile.outlook.clientSecretEnv,
				"--login-hint",
				profile.outlook.loginHint,
				"--session",
				bootstrap.sessionId,
			],
			{
				DG_HOME: daemon.dgHome,
				TEST_OUTLOOK_CLIENT_SECRET: "private-env-secret",
			},
		);
		expect(saved.code, saved.stderr).toBe(0);
		expect(JSON.parse(saved.stdout)).toEqual(
			redactPublicValue({ kind: "inbox-profile-saved", name: "work", profile }),
		);
		for (const secret of [
			profile.outlook.loginHint,
			"private-env-secret",
			bootstrap.token,
		])
			expect(saved.stdout).not.toContain(secret);
		client = await CliClient.connect({
			port: daemon.port,
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});
		const requestId = crypto.randomUUID();
		const raw = await client.request(
			{
				type: "cli-inbox-request",
				operation: "profile-get",
				name: "work",
				requestId,
			},
			(value): value is InboxCliResult =>
				typeof value === "object" &&
				value !== null &&
				"type" in value &&
				value.type === "cli-inbox-result" &&
				"requestId" in value &&
				value.requestId === requestId,
			4000,
		);
		expect(raw.ok).toBe(true);
		expect(raw.value).toEqual(profile);
		const fetched = await h.run(
			["profile", "get", "work", "--session", bootstrap.sessionId],
			{ DG_HOME: daemon.dgHome },
		);
		expect(fetched.code, fetched.stderr).toBe(0);
		expect(JSON.parse(fetched.stdout)).toEqual(
			redactPublicValue({ kind: "inbox-profile", name: "work", profile }),
		);
	} finally {
		client?.close();
		await stopServe(daemon.proc);
		cleanupDgHome(daemon.dgHome);
		h.cleanup();
	}
}, 15_000);

test.each([...providers])(
	"dg-skills inbox %s redacts provider folder addresses in ambiguity errors while keeping actionable IDs",
	async (provider) => {
		const h = inboxCliHarness();
		const privateAddresses = ["private@example.test", "another@example.test"];
		const folders = privateAddresses.map((address, index) => ({
			id: `private-folder-${index}`,
			name: "Shared",
			path: `${address}/Shared`,
			type: "folder",
		}));
		try {
			await Bun.write(
				h.dataPath,
				JSON.stringify({ folders, filters: [], messages: [] }),
			);
			const args = [
				"--provider",
				provider,
				"--dir",
				h.workspace,
				"--data-path",
				h.dataPath,
			];
			const load = await h.run(["load", "folders", ...args]);
			expect(load.code, load.stderr).toBe(0);
			const probe = await h.run(["probe", "--folder", "Shared", ...args]);
			expect(probe.code).not.toBe(0);
			expect(probe.stderr).toMatch(/ambiguous.+folder|ambiguous folder/i);
			expect(probe.stderr).toMatch(/exact folder id or path/i);
			for (const folder of folders) expect(probe.stderr).toContain(folder.id);
			for (const address of privateAddresses)
				expect(probe.stdout + probe.stderr).not.toContain(address);
		} finally {
			h.cleanup();
		}
	},
);
