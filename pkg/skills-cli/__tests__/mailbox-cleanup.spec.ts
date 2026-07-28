import { readFile } from "node:fs/promises";
import { describe, expect, it, spyOn } from "bun:test";
import { Command } from "commander";
import type { MailboxChatSubmitResult } from "../../extension/lib/features/mailbox-cleanup/bridge";
import {
	MAILBOX_PLAN_BOOTSTRAP_KEY,
	type MailboxPlanWorkspaceInput,
} from "../../extension/lib/features/mailbox-cleanup/plan-page";
import {
	bindingScope,
	captureResult,
	fingerprint,
	NEXT_REVISION_ALIAS,
	NOW_MS,
	RAW_DISPLAY_SENTINEL,
	RAW_LOCATOR_SENTINEL,
	revision,
} from "../../extension/__tests__/mailbox-plan-page-fixtures";
import {
	registerMailboxCleanup,
	runMailboxCleanup,
	type MailboxCleanupHostAdapter,
} from "../src/commands/mailbox-cleanup";
import { runMailboxCleanupLoopback } from "../src/commands/mailbox-loopback";
import { createProgram } from "../src/index";

function input(): MailboxPlanWorkspaceInput {
	return {
		capture: captureResult(),
		baseRevision: revision(),
		bindingScope: bindingScope(),
		bindingExpiresAt: NOW_MS + 60 * 60 * 1_000,
		planExpiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1_000,
	};
}

function commandSeams(
	result: MailboxChatSubmitResult,
	events: string[] = [],
): MailboxCleanupHostAdapter {
	return {
		async capture() {
			events.push("capture");
			return input();
		},
		session: {
			async set() {
				events.push("stage");
			},
			async delete() {
				events.push("delete");
			},
		},
		async computeFingerprint() {
			return fingerprint();
		},
		runtime: {
			getURL(path) {
				return `chrome-extension://dg-ai/${path}`;
			},
		},
		tabs: {
			async create() {
				events.push("open");
			},
		},
		async waitForChatTerminal() {
			events.push("terminal");
			return result;
		},
	};
}

describe("mailbox-cleanup command", () => {
	it("keeps the CLI host pending until the extension background delivers one terminal result", async () => {
		let resolveTerminal!: (value: MailboxChatSubmitResult) => void;
		const terminal = new Promise<MailboxChatSubmitResult>((resolve) => {
			resolveTerminal = resolve;
		});
		let settled = false;
		const pending = runMailboxCleanup({
			...commandSeams({ status: "canceled" }),
			async waitForChatTerminal(marker) {
				expect(marker).toEqual({ planAlias: input().baseRevision.planAlias });
				return terminal;
			},
		}).then((result) => {
			settled = true;
			return result;
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		resolveTerminal({ status: "canceled" });
		await expect(pending).resolves.toEqual({ status: "canceled" });
		expect(settled).toBe(true);
	});

	it("waits for capture, stages the exact sanitized bootstrap, opens the built page, then waits on an opaque plan marker", async () => {
		const calls: string[] = [];
		const value = input();
		let stored: unknown;

		const result = await runMailboxCleanup({
			async capture() {
				calls.push("capture");
				return value;
			},
			session: {
				async set(key, next) {
					expect(key).toBe(MAILBOX_PLAN_BOOTSTRAP_KEY);
					calls.push("stage");
					stored = structuredClone(next);
				},
				async delete() {
					calls.push("delete");
				},
			},
			async computeFingerprint() {
				return fingerprint();
			},
			runtime: {
				getURL(path) {
					expect(path).toBe("mailbox-plan.html");
					return `chrome-extension://dg-ai/${path}`;
				},
			},
			tabs: {
				async create(next) {
					calls.push("open");
					expect(next).toEqual({
						url: "chrome-extension://dg-ai/mailbox-plan.html",
					});
				},
			},
			async waitForChatTerminal(marker) {
				calls.push("terminal");
				expect(marker).toEqual({ planAlias: value.baseRevision.planAlias });
				expect(Object.isFrozen(marker)).toBe(true);
				return { status: "canceled" };
			},
		});

		expect(result).toEqual({ status: "canceled" });
		expect(stored).toEqual(value);
		expect(calls).toEqual(["capture", "stage", "open", "terminal"]);
	});

	it("registers a no-argument command and uses the concrete transport when no injected host is present", async () => {
		const registered = new Command();
		registerMailboxCleanup(registered, commandSeams({ status: "canceled" }));
		const command = registered.commands.find(
			(candidate) => candidate.name() === "mailbox-cleanup",
		);
		expect(command).toBeDefined();
		expect(command?.registeredArguments).toEqual([]);
		expect(command?.options).toEqual([]);

		const missingHost = new Command();
		let concreteRuns = 0;
		registerMailboxCleanup(missingHost, undefined, async () => {
			concreteRuns += 1;
			return { status: "canceled" };
		});
		await expect(
			missingHost.parseAsync(["node", "dg-skills", "mailbox-cleanup"], {
				from: "node",
			}),
		).resolves.toBeDefined();
		expect(concreteRuns).toBe(1);
	});

	it("completes the authenticated loopback rendezvous without putting mailbox data in its URL", async () => {
		const raw = `${RAW_DISPLAY_SENTINEL} ${RAW_LOCATOR_SENTINEL}`;
		let openedUrl = "";
		const result = await runMailboxCleanupLoopback({
			randomBytes(size) {
				return new Uint8Array(size).map((_, index) => (index + 1) % 256);
			},
			timeoutMs: 1_000,
			async open(url) {
				openedUrl = url;
				const parsed = new URL(url);
				const encoded = parsed.hash.split("=", 2)[1]!;
				const marker = JSON.parse(
					Buffer.from(encoded, "base64url").toString("utf8"),
				) as {
					origin: string;
					runAlias: string;
					nonce: string;
					token: string;
				};
				const response = await fetch(
					`${marker.origin}/mailbox-cleanup/v1/result/${marker.runAlias}`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${marker.token}`,
							"content-type": "application/json",
							"x-dg-extension-origin": "chrome-extension://dgtest",
							"x-dg-mailbox-nonce": marker.nonce,
						},
						body: JSON.stringify({ status: "canceled" }),
					},
				);
				expect(response.status).toBe(204);
				return true;
			},
		});
		expect(result).toEqual({ status: "canceled" });
		expect(openedUrl).not.toContain(raw);
		expect(new URL(openedUrl).pathname).toMatch(
			/^\/mailbox-cleanup\/v1\/connect\/run_[a-f0-9]{32}$/,
		);
	});

	it("emits one correlated sanitized JSONL request and accepts one exact Draft response", async () => {
		const lines: string[] = [];
		const base = input();
		const requestAlias = "act_0123456789abcdef0123456789abcdef";
		const chatNonce = "abcdef0123456789abcdef0123456789";
		const result = await runMailboxCleanupLoopback({
			randomBytes(size) {
				return new Uint8Array(size).map((_, index) => (index + 1) % 256);
			},
			timeoutMs: 1_000,
			writeAuthorLine(line) {
				lines.push(line);
			},
			async readAuthorLine() {
				const request = JSON.parse(lines[0]!) as {
					runAlias: string;
					planAlias: string;
					requestAlias: string;
					nonce: string;
				};
				return JSON.stringify({
					schemaVersion: 1,
					type: "dg_mailbox_author_proposal",
					runAlias: request.runAlias,
					planAlias: request.planAlias,
					requestAlias: request.requestAlias,
					nonce: request.nonce,
					proposal: base.baseRevision,
				});
			},
			async open(url) {
				const encoded = new URL(url).hash.split("=", 2)[1]!;
				const marker = JSON.parse(
					Buffer.from(encoded, "base64url").toString("utf8"),
				) as {
					origin: string;
					runAlias: string;
					nonce: string;
					token: string;
				};
				const body = JSON.stringify({
					schemaVersion: 1,
					type: "mailbox_chat_submit",
					planAlias: base.baseRevision.planAlias,
					requestAlias,
					nonce: chatNonce,
					inventory: base.capture.inventory,
					revision: base.baseRevision,
				});
				const request = (
					requestCorrelation: string,
				): Promise<Response> => fetch(
					`${marker.origin}/mailbox-cleanup/v1/author/${marker.runAlias}`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${marker.token}`,
							"content-type": "application/json",
							"x-dg-extension-origin": "chrome-extension://dgtest",
							"x-dg-mailbox-nonce": marker.nonce,
							"x-dg-mailbox-request": requestCorrelation,
						},
						body,
					},
				);
				expect(
					(await request(`${requestAlias}:${"0".repeat(32)}`)).status,
				).toBe(403);
				const response = await request(
					`${requestAlias}:${chatNonce}`,
				);
				expect(response.status).toBe(200);
				await expect(response.json()).resolves.toEqual({
					status: "proposal",
					proposal: base.baseRevision,
				});
				expect(
					(await request(`${requestAlias}:${chatNonce}`)).status,
				).toBe(403);
				return true;
			},
		});

		expect(result).toEqual({
			status: "proposal",
			proposal: base.baseRevision,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]?.endsWith("\n")).toBe(true);
		expect(JSON.parse(lines[0]!)).toEqual({
			schemaVersion: 1,
			type: "dg_mailbox_author_request",
			runAlias: "run_0102030405060708090a0b0c0d0e0f10",
			planAlias: base.baseRevision.planAlias,
			requestAlias,
			nonce: chatNonce,
			inventory: base.capture.inventory,
			revision: base.baseRevision,
		});
	});

	it("fails oversized authenticated replies without an unhandled terminal rejection", async () => {
		await expect(
			runMailboxCleanupLoopback({
				timeoutMs: 1_000,
				async open(url) {
					const parsed = new URL(url);
					const encoded = parsed.hash.split("=", 2)[1]!;
					const marker = JSON.parse(
						Buffer.from(encoded, "base64url").toString("utf8"),
					) as {
						origin: string;
						runAlias: string;
						nonce: string;
						token: string;
					};
					await fetch(
						`${marker.origin}/mailbox-cleanup/v1/result/${marker.runAlias}`,
						{
							method: "POST",
							headers: {
								authorization: `Bearer ${marker.token}`,
								"content-type": "application/json",
								"x-dg-extension-origin":
									"chrome-extension://dgtest",
								"x-dg-mailbox-nonce": marker.nonce,
							},
							body: "x".repeat(2_000_001),
						},
					);
					return true;
				},
			}),
		).rejects.toThrow("failed safely");
	});

	it("routes the real index command through its production command registration to one terminal result", async () => {
		const logs: string[] = [];
		const log = spyOn(console, "error").mockImplementation((...parts) => {
			logs.push(parts.join(" "));
		});
		try {
			let calls = 0;
			const program = createProgram({
				async mailboxCleanup() {
					calls += 1;
					return { status: "canceled" };
				},
			});
			await program.parseAsync(
				["node", "dg-browser", "mailbox-cleanup"],
				{ from: "node" },
			);
			expect(calls).toBe(1);
			expect(logs).toEqual(["Mailbox cleanup was canceled."]);
		} finally {
			log.mockRestore();
		}
	});

	it("waits for each typed terminal result without leaking mailbox data through argv, URL, storage, terminal markers, or logs", async () => {
		const terminalResults: readonly MailboxChatSubmitResult[] = [
			{
				status: "proposal",
				proposal: revision({
					revisionAlias: NEXT_REVISION_ALIAS,
				}),
			},
			{ status: "canceled" },
			{ status: "error", code: "internal_failure" },
		];

		for (const terminalResult of terminalResults) {
			const raw = `${RAW_DISPLAY_SENTINEL} ${RAW_LOCATOR_SENTINEL}`;
			const base = input();
			const capture = {
				...base.capture,
				bodyChecks: {
					results: [
						{
							messageAlias: base.capture.inventory.messages[0]!.alias,
							text: raw,
							characterCount: [...raw].length,
						},
					],
				},
			};
			const value = { ...base, capture };
			const argv = ["node", "dg-skills", "mailbox-cleanup"];
			const urls: string[] = [];
			const logs: string[] = [];
			const terminalMarkers: unknown[] = [];
			let stored: unknown;
			const log = spyOn(console, "error").mockImplementation(
				(...parts: unknown[]) => {
					logs.push(parts.join(" "));
				},
			);
			try {
				const program = new Command();
				registerMailboxCleanup(program, {
					async capture() {
						return value;
					},
					session: {
						async set(_key, next) {
							stored = structuredClone(next);
						},
						async delete() {},
					},
					async computeFingerprint() {
						return fingerprint();
					},
					runtime: {
						getURL(path) {
							const url = `chrome-extension://dg-ai/${path}`;
							urls.push(url);
							return url;
						},
					},
					tabs: {
						async create() {},
					},
					async waitForChatTerminal(marker) {
						terminalMarkers.push(structuredClone(marker));
						return terminalResult;
					},
				});
				await program.parseAsync(argv, { from: "node" });
			} finally {
				log.mockRestore();
			}

			expect(terminalMarkers).toEqual([
				{ planAlias: base.baseRevision.planAlias },
			]);
			const externalCorpus = JSON.stringify({
				argv,
				urls,
				logs,
				stored,
				terminalMarkers,
			});
			expect(externalCorpus).not.toContain(RAW_DISPLAY_SENTINEL);
			expect(externalCorpus).not.toContain(RAW_LOCATOR_SENTINEL);
			expect(urls).toEqual(["chrome-extension://dg-ai/mailbox-plan.html"]);
		}
	});

	it("sanitizes thrown capture, session, tab, and terminal host failures", async () => {
		const raw = `${RAW_DISPLAY_SENTINEL} ${RAW_LOCATOR_SENTINEL}`;
		const failure = () => {
			throw new Error(raw);
		};
		const base = commandSeams({ status: "canceled" });
		const hosts: readonly MailboxCleanupHostAdapter[] = [
			{ ...base, capture: failure },
			{
				...base,
				session: {
					...base.session,
					set: failure,
				},
			},
			{
				...base,
				tabs: {
					create: failure,
				},
			},
			{ ...base, waitForChatTerminal: failure },
		];

		for (const host of hosts) {
			const thrown = await runMailboxCleanup(host).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(thrown).toBeInstanceOf(Error);
			const externalMessage = String(thrown);
			expect(externalMessage).toMatch(/mailbox cleanup.*failed safely/i);
			expect(externalMessage).not.toContain(RAW_DISPLAY_SENTINEL);
			expect(externalMessage).not.toContain(RAW_LOCATOR_SENTINEL);
		}
	});

	it("rejects hostile resolved terminal values before logging and sanitizes the failure", async () => {
		const raw = `${RAW_DISPLAY_SENTINEL} ${RAW_LOCATOR_SENTINEL}`;
		const inherited = Object.assign(
			Object.create({ inherited: raw }) as Record<string, unknown>,
			{ status: "canceled" },
		);
		const hostileValues: readonly unknown[] = [
			{ status: raw },
			{ status: "error", code: raw },
			{ status: "canceled", extra: raw },
			{ status: "proposal", proposal: { raw } },
			inherited,
		];

		for (const terminalValue of hostileValues) {
			const logs: string[] = [];
			const log = spyOn(console, "error").mockImplementation(
				(...parts: unknown[]) => {
					logs.push(parts.join(" "));
				},
			);
			let thrown: unknown;
			try {
				const program = new Command();
				registerMailboxCleanup(program, commandSeams(terminalValue as never));
				thrown = await program
					.parseAsync(["node", "dg-skills", "mailbox-cleanup"], {
						from: "node",
					})
					.then(
						() => undefined,
						(error: unknown) => error,
					);
			} finally {
				log.mockRestore();
			}

			expect(thrown).toBeInstanceOf(Error);
			const externalCorpus = JSON.stringify({
				error: String(thrown),
				logs,
			});
			expect(externalCorpus).toMatch(/terminal_failed/);
			expect(externalCorpus).not.toContain(RAW_DISPLAY_SENTINEL);
			expect(externalCorpus).not.toContain(RAW_LOCATOR_SENTINEL);
			expect(logs).toEqual([]);
		}
	});

	it("ships a concise skill trigger and explicit review-before-execution workflow", async () => {
		const source = await readFile(
			new URL(
				"../../../plugins/dg/skills/inbox-cleanup/SKILL.md",
				import.meta.url,
			),
			"utf8",
		);

		expect(source.length).toBeLessThan(2_500);
		expect(source).toMatch(
			/description:.*clean.*organize.*archive.*mark read.*label.*move.*review/i,
		);
		expect(source).toContain("dg-skills mailbox-cleanup");
		expect(source).toMatch(
			/require an installed, connected `dg-ai-extension` mailbox host/i,
		);
		expect(source).toMatch(/if it is unavailable, stop with the host error/i);
		expect(source).toMatch(/typed proposal, cancellation, or error result/i);
		expect(source).toMatch(/Accept Revision.*before execution/i);
		expect(source).toMatch(
			/Never treat Save Draft or Submit to Chat as approval/i,
		);
		expect(source).toMatch(
			/raw message text, provider locators, account identifiers, and temporary bindings out of chat, files, URLs, logs, and command arguments/i,
		);
	});
});
