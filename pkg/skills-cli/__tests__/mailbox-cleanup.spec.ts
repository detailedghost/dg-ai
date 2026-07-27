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

	it("registers a no-argument command and fails closed when the extension host adapter is absent", async () => {
		const registered = new Command();
		registerMailboxCleanup(registered, commandSeams({ status: "canceled" }));
		const command = registered.commands.find(
			(candidate) => candidate.name() === "mailbox-cleanup",
		);
		expect(command).toBeDefined();
		expect(command?.registeredArguments).toEqual([]);
		expect(command?.options).toEqual([]);

		const missingHost = new Command();
		registerMailboxCleanup(missingHost);
		await expect(
			missingHost.parseAsync(["node", "dg-skills", "mailbox-cleanup"], {
				from: "node",
			}),
		).rejects.toThrow(
			"mailbox-cleanup requires an installed, connected dg-ai-extension mailbox host",
		);
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
			const log = spyOn(console, "log").mockImplementation(
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
			const log = spyOn(console, "log").mockImplementation(
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
