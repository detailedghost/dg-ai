import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { connect, type Socket } from "node:net";
import {
	MAILBOX_PLANS_CLI_REQUEST_TYPE,
	MAILBOX_PLANS_CLI_TERMINAL_TYPE,
	type MailboxPlansCliRequest,
	type MailboxPlansCliTerminal,
	parseMailboxCliMarker,
} from "../../extension/lib/features/mailbox-cleanup/cli-transport";
import type {
	MailboxPlanListActionResult,
	MailboxPlanListRow,
} from "../../extension/lib/features/mailbox-cleanup/plan-workspace/list";
import {
	MAILBOX_PLANS_EXIT_CODES,
	registerMailboxPlans,
	runMailboxPlansLoopback,
	type MailboxPlansRunner,
} from "../src/commands/mailbox-plans";

const PLAN_ALIAS = "plan_00112233445566778899aabbccddeeff";
const REVISION_ALIAS = "rev_102132435465768798a9bacbdcedfe0f";
const RAW_SENTINEL = "raw-provider-locator:alice@example.test";

type SlowPost = Readonly<{
	socket: Socket;
	finish(): void;
	response: Promise<number>;
}>;

async function slowPost(
	url: string,
	headers: Readonly<Record<string, string>>,
	body: string,
): Promise<SlowPost> {
	const target = new URL(url);
	const socket = connect({
		host: target.hostname,
		port: Number(target.port),
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	let responseText = "";
	const response = new Promise<number>((resolve, reject) => {
		socket.on("data", (chunk) => {
			responseText += chunk.toString("utf8");
			const match = /^HTTP\/1\.1 (\d{3})/.exec(responseText);
			if (match !== null) resolve(Number(match[1]));
		});
		socket.once("error", reject);
	});
	socket.write(
		[
			`POST ${target.pathname} HTTP/1.1`,
			`Host: ${target.host}`,
			...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
			`Content-Length: ${Buffer.byteLength(body)}`,
			"Connection: close",
			"",
			"",
		].join("\r\n"),
	);
	return Object.freeze({
		socket,
		finish() {
			socket.write(body);
		},
		response,
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listRequest(seed = 1): Extract<
	MailboxPlansCliRequest,
	{ operation: "list" }
> {
	return {
		schemaVersion: 1,
		type: MAILBOX_PLANS_CLI_REQUEST_TYPE,
		requestAlias: `req_${seed.toString(16).padStart(32, "0")}`,
		operation: "list",
		query: { states: [], stale: "all" },
	};
}

function row(
	overrides: Partial<MailboxPlanListRow> = {},
): MailboxPlanListRow {
	return {
		schemaVersion: 1,
		planAlias: PLAN_ALIAS,
		revisionAlias: REVISION_ALIAS,
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: "acct_30415263748596a7b8c9daebfc0d1e2f",
		lifecycleState: "draft",
		stale: false,
		staleReason: "none",
		updatedAt: "2026-07-28T12:00:00.000Z",
		expiresAt: "2099-07-28T12:00:00.000Z",
		nextAction: { type: "edit" },
		...overrides,
	};
}

function completedList(
	request: MailboxPlansCliRequest,
	rows: readonly MailboxPlanListRow[] = [],
): MailboxPlansCliTerminal {
	if (request.operation !== "list") throw new Error("Expected list request");
	return {
		schemaVersion: 1,
		type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
		requestAlias: request.requestAlias,
		operation: "list",
		status: "completed",
		result: { schemaVersion: 1, rows },
	};
}

function actionResult(
	request: Exclude<MailboxPlansCliRequest, { operation: "list" }>,
	status: MailboxPlanListActionResult["status"] = "completed",
): MailboxPlansCliTerminal {
	const result: MailboxPlanListActionResult =
		status === "completed"
			? {
					schemaVersion: 1,
					status,
					requestAlias: request.requestAlias,
					action: request.operation,
					planAlias: request.command.planAlias,
					revisionAlias: request.command.revisionAlias,
					lifecycleState:
						request.operation === "edit"
							? "draft"
							: request.operation === "focus" ||
									request.operation === "resume"
								? "in_flight"
								: "approved",
					preservedApproval: request.operation !== "edit",
				}
			: status === "blocked"
				? {
						schemaVersion: 1,
						status,
						requestAlias: request.requestAlias,
						action: request.operation,
						reason: "missing_session",
					}
				: {
						schemaVersion: 1,
						status,
						requestAlias: request.requestAlias,
						action: request.operation,
					};
	return {
		schemaVersion: 1,
		type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
		requestAlias: request.requestAlias,
		operation: request.operation,
		status: "completed",
		result,
	};
}

async function invoke(
	args: readonly string[],
	run: MailboxPlansRunner,
) {
	const stdout: string[] = [];
	const exitCodes: number[] = [];
	const program = new Command();
	registerMailboxPlans(program, run, {
		writeStdout(value) {
			stdout.push(value);
		},
		setExitCode(value) {
			exitCodes.push(value);
		},
	});
	await program.parseAsync(["node", "dg-browser", ...args], {
		from: "node",
	});
	return { stdout, exitCodes };
}

describe("mailbox-plans CLI adversarial contract", () => {
	it("emits exact unique requests for every operation and composes all state and stale filters", async () => {
		const requests: MailboxPlansCliRequest[] = [];
		const runner: MailboxPlansRunner = async (request) => {
			requests.push(request);
			return request.operation === "list"
				? completedList(request)
				: actionResult(request);
		};

		const listed = await invoke(
			[
				"mailbox-plans",
				"list",
				"--state",
				"draft",
				"--state",
				"approved",
				"--state",
				"in_flight",
				"--state",
				"completed",
				"--stale",
				"only",
				"--timeout",
				"100",
			],
			runner,
		);
		expect(requests[0]).toMatchObject({
			operation: "list",
			query: {
				states: ["draft", "approved", "in_flight", "completed"],
				stale: "only",
			},
		});
		expect(listed.stdout).toHaveLength(1);
		expect(listed.exitCodes).toEqual([MAILBOX_PLANS_EXIT_CODES.success]);

		for (const operation of [
			"edit",
			"preflight",
			"focus",
			"resume",
			"restart",
		] as const) {
			const result = await invoke(
				["mailbox-plans", operation, PLAN_ALIAS, REVISION_ALIAS],
				runner,
			);
			expect(result.stdout).toHaveLength(1);
			expect(requests.at(-1)).toMatchObject({
				operation,
				command: {
					schemaVersion: 1,
					type: operation,
					planAlias: PLAN_ALIAS,
					revisionAlias: REVISION_ALIAS,
				},
			});
			const request = requests.at(-1);
			if (request === undefined || request.operation === "list") {
				throw new Error("Expected an action request");
			}
			expect(request.requestAlias).toBe(request.command.requestAlias);
		}

		expect(new Set(requests.map((request) => request.requestAlias)).size).toBe(
			requests.length,
		);
	});

	it("maps completed, blocked, canceled, timeout, refusal, and internal outcomes to exact exit codes", async () => {
		const cases: readonly Readonly<{
			terminal(
				request: Exclude<MailboxPlansCliRequest, { operation: "list" }>,
			): MailboxPlansCliTerminal;
			exitCode: number;
		}>[] = [
			{
				terminal: (request) => actionResult(request),
				exitCode: MAILBOX_PLANS_EXIT_CODES.success,
			},
			{
				terminal: (request) => actionResult(request, "blocked"),
				exitCode: MAILBOX_PLANS_EXIT_CODES.blocked,
			},
			{
				terminal: (request) => actionResult(request, "canceled"),
				exitCode: MAILBOX_PLANS_EXIT_CODES.canceled,
			},
			{
				terminal: (request) => ({
					schemaVersion: 1,
					type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
					requestAlias: request.requestAlias,
					operation: request.operation,
					status: "canceled",
				}),
				exitCode: MAILBOX_PLANS_EXIT_CODES.canceled,
			},
			{
				terminal: (request) => ({
					schemaVersion: 1,
					type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
					requestAlias: request.requestAlias,
					operation: request.operation,
					status: "error",
					code: "provider_timeout",
					retryable: true,
				}),
				exitCode: MAILBOX_PLANS_EXIT_CODES.timeout,
			},
			{
				terminal: (request) => ({
					schemaVersion: 1,
					type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
					requestAlias: request.requestAlias,
					operation: request.operation,
					status: "error",
					code: "provider_refused",
					retryable: true,
				}),
				exitCode: MAILBOX_PLANS_EXIT_CODES.blocked,
			},
			{
				terminal: (request) => ({
					schemaVersion: 1,
					type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
					requestAlias: request.requestAlias,
					operation: request.operation,
					status: "error",
					code: "internal_failure",
					retryable: false,
				}),
				exitCode: MAILBOX_PLANS_EXIT_CODES.failure,
			},
		];

		for (const testCase of cases) {
			const output = await invoke(
				["mailbox-plans", "restart", PLAN_ALIAS, REVISION_ALIAS],
				async (request) => {
					if (request.operation === "list") {
						throw new Error("Expected restart request");
					}
					return testCase.terminal(request);
				},
			);
			expect(output.exitCodes).toEqual([testCase.exitCode]);
			expect(output.stdout).toHaveLength(1);
			expect(output.stdout[0]?.endsWith("\n")).toBe(true);
		}
	});

	it("allows one request claim and one terminal response, then rejects both replay paths", async () => {
		const request = listRequest();
		let requestReplay = 0;
		let terminalReplay = 0;
		const result = await runMailboxPlansLoopback(request, {
			timeoutMs: 1_000,
			randomBytes(size) {
				return Uint8Array.from(
					{ length: size },
					(_unused, index) => (index + 1) % 256,
				);
			},
			async open(url) {
				const connection = parseMailboxCliMarker(url);
				if (connection === undefined) throw new Error("Missing marker");
				const headers = {
					authorization: `Bearer ${connection.token}`,
					"content-type": "application/json",
					"x-dg-extension-origin": "chrome-extension://dgtest",
					"x-dg-mailbox-nonce": connection.nonce,
				};
				const claimUrl =
					`${connection.origin}/mailbox-cleanup/v1/request/` +
					connection.runAlias;
				const firstClaim = await fetch(claimUrl, {
					method: "POST",
					headers,
					body: "{}",
				});
				expect(firstClaim.status).toBe(200);
				const claimed = (await firstClaim.json()) as MailboxPlansCliRequest;
				const secondClaim = await fetch(claimUrl, {
					method: "POST",
					headers,
					body: "{}",
				});
				requestReplay = secondClaim.status;
				const terminal = completedList(claimed);
				const resultUrl =
					`${connection.origin}/mailbox-cleanup/v1/result/` +
					connection.runAlias;
				const firstTerminal = await fetch(resultUrl, {
					method: "POST",
					headers,
					body: JSON.stringify(terminal),
				});
				expect(firstTerminal.status).toBe(204);
				const secondTerminal = await fetch(resultUrl, {
					method: "POST",
					headers,
					body: JSON.stringify(terminal),
				});
				terminalReplay = secondTerminal.status;
				return true;
			},
		});

		expect(result).toEqual(completedList(request));
		expect(requestReplay).toBe(403);
		expect(terminalReplay).toBe(403);
	});

	it("reserves concurrent request and terminal phases before either body finishes", async () => {
		const request = listRequest(20);
		let acceptedTerminal: Promise<number> | undefined;
		const result = await runMailboxPlansLoopback(request, {
			timeoutMs: 1_000,
			async open(url) {
				const connection = parseMailboxCliMarker(url);
				if (connection === undefined) throw new Error("Missing marker");
				const headers = {
					authorization: `Bearer ${connection.token}`,
					"content-type": "application/json",
					"x-dg-extension-origin": "chrome-extension://dgtest",
					"x-dg-mailbox-nonce": connection.nonce,
				};
				const claimUrl =
					`${connection.origin}/mailbox-cleanup/v1/request/` +
					connection.runAlias;
				const reservedClaim = await slowPost(claimUrl, headers, "{}");
				await delay(20);
				const competingClaim = await fetch(claimUrl, {
					method: "POST",
					headers,
					body: "{}",
				});
				expect(competingClaim.status).toBe(403);
				reservedClaim.finish();
				expect(await reservedClaim.response).toBe(200);

				const terminal = completedList(request);
				const resultUrl =
					`${connection.origin}/mailbox-cleanup/v1/result/` +
					connection.runAlias;
				const terminalBody = JSON.stringify(terminal);
				const reservedTerminal = await slowPost(
					resultUrl,
					headers,
					terminalBody,
				);
				await delay(20);
				const competingTerminal = await fetch(resultUrl, {
					method: "POST",
					headers,
					body: terminalBody,
				});
				expect(competingTerminal.status).toBe(403);
				reservedTerminal.finish();
				acceptedTerminal = reservedTerminal.response;
				return true;
			},
		});

		expect(result).toEqual(completedList(request));
		expect(await acceptedTerminal).toBe(204);
	});

	it("returns typed timeout and cancellation terminals without accepting a late result", async () => {
		const timeoutRequest = listRequest(2);
		const timedOut = await runMailboxPlansLoopback(timeoutRequest, {
			timeoutMs: 100,
			async open() {
				return true;
			},
		});
		expect(timedOut).toMatchObject({
			requestAlias: timeoutRequest.requestAlias,
			operation: "list",
			status: "error",
			code: "provider_timeout",
			retryable: true,
		});

		const controller = new AbortController();
		const canceledRequest = listRequest(3);
		const canceled = await runMailboxPlansLoopback(canceledRequest, {
			timeoutMs: 1_000,
			signal: controller.signal,
			async open() {
				controller.abort();
				return true;
			},
		});
		expect(canceled).toEqual({
			schemaVersion: 1,
			type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
			requestAlias: canceledRequest.requestAlias,
			operation: "list",
			status: "canceled",
		});
	});

	it("bounds a hung opener and forcibly closes a slow claimed body at timeout", async () => {
		const hungRequest = listRequest(21);
		const hungStarted = Date.now();
		const hung = await runMailboxPlansLoopback(hungRequest, {
			timeoutMs: 100,
			open: () => new Promise<boolean>(() => undefined),
		});
		expect(Date.now() - hungStarted).toBeLessThan(750);
		expect(hung).toMatchObject({
			status: "error",
			code: "provider_timeout",
		});

		const slowRequest = listRequest(22);
		let reserved: SlowPost | undefined;
		let claimUrl = "";
		let claimHeaders: Readonly<Record<string, string>> = {};
		const timedOut = await runMailboxPlansLoopback(slowRequest, {
			timeoutMs: 100,
			async open(url) {
				const connection = parseMailboxCliMarker(url);
				if (connection === undefined) throw new Error("Missing marker");
				claimHeaders = {
					authorization: `Bearer ${connection.token}`,
					"content-type": "application/json",
					"x-dg-extension-origin": "chrome-extension://dgtest",
					"x-dg-mailbox-nonce": connection.nonce,
				};
				claimUrl =
					`${connection.origin}/mailbox-cleanup/v1/request/` +
					connection.runAlias;
				reserved = await slowPost(claimUrl, claimHeaders, "{}");
				void reserved.response.catch(() => undefined);
				await delay(20);
				return true;
			},
		});
		expect(timedOut).toMatchObject({
			status: "error",
			code: "provider_timeout",
		});
		expect(reserved).toBeDefined();
		reserved!.finish();
		const lateSlowStatus = await Promise.race([
			reserved!.response.catch(() => 0),
			delay(250).then(() => -1),
		]);
		expect(lateSlowStatus).not.toBe(200);
		reserved!.socket.destroy();
		let acceptedAfterTimeout = false;
		try {
			const response = await fetch(claimUrl, {
				method: "POST",
				headers: claimHeaders,
				body: "{}",
			});
			acceptedAfterTimeout = response.status === 200;
		} catch {
			acceptedAfterTimeout = false;
		}
		expect(acceptedAfterTimeout).toBe(false);
	});

	it("fails closed on raw or expired terminal data and prints one sanitized JSONL record", async () => {
		const malformed = await invoke(
			["mailbox-plans", "list"],
			async (request) =>
				({
					...completedList(request),
					rawLocator: RAW_SENTINEL,
				}) as unknown as MailboxPlansCliTerminal,
		);
		expect(malformed.exitCodes).toEqual([MAILBOX_PLANS_EXIT_CODES.failure]);
		expect(malformed.stdout).toHaveLength(1);
		expect(malformed.stdout[0]).not.toContain(RAW_SENTINEL);
		expect(JSON.parse(malformed.stdout[0]!)).toMatchObject({
			status: "error",
			code: "internal_failure",
			retryable: false,
		});

		const expired = await invoke(
			["mailbox-plans", "list"],
			async (request) =>
				completedList(request, [
					row({ expiresAt: "2020-01-01T00:00:00.000Z" }),
				]),
		);
		expect(expired.exitCodes).toEqual([MAILBOX_PLANS_EXIT_CODES.failure]);
		expect(JSON.parse(expired.stdout[0]!)).toMatchObject({
			status: "error",
			code: "internal_failure",
		});
	});

	it("keeps a disconnected edit recoverable as the same sanitized Draft on the next list", async () => {
		const calls: MailboxPlansCliRequest[] = [];
		const runner: MailboxPlansRunner = async (request) => {
			calls.push(request);
			if (request.operation === "list") {
				return completedList(request, [row()]);
			}
			return {
				schemaVersion: 1,
				type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
				requestAlias: request.requestAlias,
				operation: request.operation,
				status: "canceled",
			};
		};

		const disconnected = await invoke(
			["mailbox-plans", "edit", PLAN_ALIAS, REVISION_ALIAS],
			runner,
		);
		expect(disconnected.exitCodes).toEqual([
			MAILBOX_PLANS_EXIT_CODES.canceled,
		]);

		const recovered = await invoke(["mailbox-plans", "list"], runner);
		const terminal = JSON.parse(recovered.stdout[0]!) as {
			result: { rows: MailboxPlanListRow[] };
		};
		expect(terminal.result.rows).toEqual([row()]);
		expect(terminal.result.rows[0]).toMatchObject({
			lifecycleState: "draft",
			nextAction: { type: "edit" },
		});
		expect(JSON.stringify({ calls, terminal })).not.toContain(RAW_SENTINEL);
	});
});
