import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import {
	MAILBOX_PLAN_LIST_STATES,
	type MailboxPlanListRow,
} from "../../extension/lib/features/mailbox-cleanup/plan-workspace/list";
import {
	MAILBOX_PLANS_CLI_TERMINAL_TYPE,
	type MailboxPlansCliRequest,
	type MailboxPlansCliTerminal,
} from "../../extension/lib/features/mailbox-cleanup/cli-transport";
import {
	MAILBOX_PLANS_EXIT_CODES,
	registerMailboxPlans,
	runMailboxPlansLoopback,
	type MailboxPlansIo,
} from "../src/commands/mailbox-plans";

const PLAN_ALIAS = "plan_0123456789abcdef0123456789abcdef";
const REVISION_ALIAS = "rev_0123456789abcdef0123456789abcdef";
const ACCOUNT_ALIAS = "acct_0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-07-28T12:00:00.000Z");

function row(
	updatedAt = "2026-07-28T11:00:00.000Z",
	planAlias = PLAN_ALIAS,
) {
	return {
		schemaVersion: 1 as const,
		planAlias,
		revisionAlias: REVISION_ALIAS,
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: ACCOUNT_ALIAS,
		lifecycleState: "draft" as const,
		stale: false,
		staleReason: "check_required" as const,
		updatedAt,
		expiresAt: "9999-12-31T23:59:59.999Z",
		nextAction: { type: "edit" as const },
	};
}

function completed(
	request: MailboxPlansCliRequest,
	rows: readonly MailboxPlanListRow[] = [row()],
): MailboxPlansCliTerminal {
	if (request.operation !== "list") {
		return {
			schemaVersion: 1,
			type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
			requestAlias: request.requestAlias,
			operation: request.operation,
			status: "completed",
			result: {
				schemaVersion: 1,
				status: "completed",
				requestAlias: request.requestAlias,
				action: request.operation,
				planAlias: request.command.planAlias,
				revisionAlias: request.command.revisionAlias,
				lifecycleState: "draft",
				preservedApproval: false,
			},
		};
	}
	return {
		schemaVersion: 1,
		type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
		requestAlias: request.requestAlias,
		operation: "list",
		status: "completed",
		result: { schemaVersion: 1, rows },
	};
}

function io() {
	const lines: string[] = [];
	const exits: number[] = [];
	const seam: MailboxPlansIo = {
		writeStdout: (value) => lines.push(value),
		setExitCode: (value) => exits.push(value),
	};
	return { lines, exits, seam };
}

describe("mailbox-plans command", () => {
	it("registers list, edit, preflight, focus, resume, and restart", () => {
		const program = new Command();
		registerMailboxPlans(program, async (request) => completed(request));
		const root = program.commands.find(
			(command) => command.name() === "mailbox-plans",
		);
		expect(root?.commands.map((command) => command.name())).toEqual([
			"list",
			"edit",
			"preflight",
			"focus",
			"resume",
			"restart",
		]);
	});

	it("parses composable lifecycle/stale filters and emits one stable JSON result", async () => {
		const output = io();
		let seen: MailboxPlansCliRequest | undefined;
		const program = new Command();
		registerMailboxPlans(
			program,
			async (request) => {
				seen = request;
				return completed(
					request,
					[
						row(
							"2026-07-28T10:00:00.000Z",
							"plan_11111111111111111111111111111111",
						),
						row("2026-07-28T11:00:00.000Z"),
					].map((value) => ({
						...value,
						stale: true,
						staleReason: "restart_required" as const,
						nextAction: { type: "restart" as const },
					})),
				);
			},
			output.seam,
		);

		await program.parseAsync(
			[
				"node",
				"dg-skills",
				"mailbox-plans",
				"list",
				"--state",
				"draft",
				"--state",
				"approved",
				"--stale",
				"only",
				"--provider",
				"fake-mail",
				"--surface",
				"inbox",
				"--account",
				ACCOUNT_ALIAS,
			],
			{ from: "node" },
		);

		expect(seen).toMatchObject({
			schemaVersion: 1,
			operation: "list",
			query: {
				states: ["draft", "approved"],
				stale: "only",
				providerId: "fake-mail",
				surface: "inbox",
				accountAlias: ACCOUNT_ALIAS,
			},
		});
		expect(seen?.requestAlias).toMatch(/^req_[a-f0-9]{32}$/);
		expect(output.lines).toHaveLength(1);
		const terminal = JSON.parse(output.lines[0]!) as {
			result: { rows: { planAlias: string }[] };
		};
		expect(terminal.result.rows.map((value) => value.planAlias)).toEqual([
			PLAN_ALIAS,
			"plan_11111111111111111111111111111111",
		]);
		expect(output.exits).toEqual([MAILBOX_PLANS_EXIT_CODES.success]);
	});

	it("builds exact action commands and maps blocked results to exit 4", async () => {
		const output = io();
		let seen: MailboxPlansCliRequest | undefined;
		const program = new Command();
		registerMailboxPlans(
			program,
			async (request) => {
				seen = request;
				return {
					schemaVersion: 1,
					type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
					requestAlias: request.requestAlias,
					operation: "restart",
					status: "completed",
					result: {
						schemaVersion: 1,
						status: "blocked",
						requestAlias: request.requestAlias,
						action: "restart",
						reason: "fingerprint_mismatch",
					},
				};
			},
			output.seam,
		);

		await program.parseAsync(
			[
				"node",
				"dg-skills",
				"mailbox-plans",
				"restart",
				PLAN_ALIAS,
				REVISION_ALIAS,
			],
			{ from: "node" },
		);

		expect(seen).toMatchObject({
			operation: "restart",
			command: {
				type: "restart",
				planAlias: PLAN_ALIAS,
				revisionAlias: REVISION_ALIAS,
			},
		});
		expect(output.lines).toHaveLength(1);
		expect(output.exits).toEqual([MAILBOX_PLANS_EXIT_CODES.blocked]);
	});

	it("runs a real authenticated loopback and rejects request and terminal replay", async () => {
		let requestPosts = 0;
		let resultPosts = 0;
		const request: MailboxPlansCliRequest = {
			schemaVersion: 1,
			type: "dg_mailbox_plans_request",
			requestAlias: "req_0123456789abcdef0123456789abcdef",
			operation: "list",
			query: {
				states: [...MAILBOX_PLAN_LIST_STATES],
				stale: "all",
			},
		};
		const result = await runMailboxPlansLoopback(request, {
			timeoutMs: 1_000,
			randomBytes(size) {
				return Uint8Array.from({ length: size }, (_, index) => index + 1);
			},
			async open(url) {
				const parsed = new URL(url);
				expect(parsed.pathname).toMatch(
					/^\/mailbox-cleanup\/v1\/connect\/run_[a-f0-9]{32}$/,
				);
				const marker = JSON.parse(
					Buffer.from(
						parsed.hash.split("=", 2)[1]!,
						"base64url",
					).toString("utf8"),
				) as {
					origin: string;
					runAlias: string;
					nonce: string;
					token: string;
					purpose: string;
				};
				expect(marker.purpose).toBe("plans");
				expect(url).not.toContain(PLAN_ALIAS);
				const headers = {
					authorization: `Bearer ${marker.token}`,
					"content-type": "application/json",
					"x-dg-extension-origin": "chrome-extension://dgtest",
					"x-dg-mailbox-nonce": marker.nonce,
				};
				const requestUrl =
					`${marker.origin}/mailbox-cleanup/v1/request/` +
					marker.runAlias;
				const first = await fetch(requestUrl, {
					method: "POST",
					headers,
					body: "{}",
				});
				requestPosts += 1;
				expect(first.status).toBe(200);
				await expect(first.json()).resolves.toEqual(request);
				const replay = await fetch(requestUrl, {
					method: "POST",
					headers,
					body: "{}",
				});
				requestPosts += 1;
				expect(replay.status).toBe(403);

				const terminal = completed(request);
				const resultUrl =
					`${marker.origin}/mailbox-cleanup/v1/result/` +
					marker.runAlias;
				const accepted = await fetch(resultUrl, {
					method: "POST",
					headers,
					body: JSON.stringify(terminal),
				});
				resultPosts += 1;
				expect(accepted.status).toBe(204);
				const repeated = await fetch(resultUrl, {
					method: "POST",
					headers,
					body: JSON.stringify(terminal),
				});
				resultPosts += 1;
				expect(repeated.status).toBe(403);
				return true;
			},
		});

		expect(result).toEqual(completed(request));
		expect(requestPosts).toBe(2);
		expect(resultPosts).toBe(2);
	});

	it("returns correlated timeout and cancellation terminals without leaking", async () => {
		const request: MailboxPlansCliRequest = {
			schemaVersion: 1,
			type: "dg_mailbox_plans_request",
			requestAlias: "req_0123456789abcdef0123456789abcdef",
			operation: "list",
			query: {
				states: [...MAILBOX_PLAN_LIST_STATES],
				stale: "all",
			},
		};
		const timedOut = await runMailboxPlansLoopback(request, {
			timeoutMs: 100,
			open: async () => true,
		});
		expect(timedOut).toEqual({
			schemaVersion: 1,
			type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
			requestAlias: request.requestAlias,
			operation: "list",
			status: "error",
			code: "provider_timeout",
			retryable: true,
		});

		const controller = new AbortController();
		controller.abort();
		await expect(
			runMailboxPlansLoopback(request, {
				signal: controller.signal,
			}),
		).resolves.toMatchObject({
			requestAlias: request.requestAlias,
			status: "canceled",
		});
	});

	it("fails closed instead of printing rows expired during transport", async () => {
		const output = io();
		const program = new Command();
		registerMailboxPlans(
			program,
			async (request) =>
				completed(request, [
					{
						...row(),
						expiresAt: new Date(NOW - 1).toISOString(),
					},
				]),
			output.seam,
		);
		const originalNow = Date.now;
		Date.now = () => NOW;
		try {
			await program.parseAsync(
				["node", "dg-skills", "mailbox-plans", "list"],
				{ from: "node" },
			);
		} finally {
			Date.now = originalNow;
		}
		expect(JSON.parse(output.lines[0]!)).toMatchObject({
			status: "error",
			code: "internal_failure",
		});
		expect(output.lines[0]).not.toContain(ACCOUNT_ALIAS);
		expect(output.exits).toEqual([MAILBOX_PLANS_EXIT_CODES.failure]);
	});
});
