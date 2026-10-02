import { describe, expect, it } from "bun:test";
import type {
	CliOverwatchSnapshotResult,
	CliRequest,
	OverwatchBoard,
} from "@dg/common";
import { DgCliError } from "@dg/common";
import { Command } from "commander";
import {
	registerOverwatchCommands,
	type OverwatchClient,
} from "../src/overwatch";

const BOARD: OverwatchBoard = {
	goLive: "2026-10-24T14:00:00.000Z",
	goNoGo: "2026-10-17T14:00:00.000Z",
	lanes: [
		{
			chat: "print",
			task: "Prepare launch collateral",
			stage: "e2e",
			mr: "!298",
			eta: "20m",
			next: "Approve copy",
			url: "https://claude.ai/code/session-123",
			kind: "chat",
			publisher: "overwatch",
			updatedAt: "2026-10-02T15:00:00.000Z",
		},
	],
	merges: [
		{
			mr: "!297",
			title: "Add launch checklist",
			at: "2026-10-02T14:00:00.000Z",
		},
	],
};

class StubClient implements OverwatchClient {
	readonly frames: CliRequest[] = [];
	closeCount = 0;
	openResult: unknown = { type: "cli-overwatch-open-result" };
	mutationResult: unknown;

	constructor(
		private readonly snapshot: CliOverwatchSnapshotResult = {
			type: "cli-overwatch-snapshot-result",
			board: BOARD,
		},
	) {}

	send(frame: CliRequest): void {
		this.frames.push(frame);
	}

	async request<T>(
		frame: CliRequest,
		accept: (value: unknown) => value is T,
	): Promise<T> {
		this.frames.push(frame);
		const operation =
			frame.type === "cli-overwatch-set"
				? "set"
				: frame.type === "cli-overwatch-remove"
					? "remove"
					: frame.type === "cli-overwatch-merged"
						? "merged"
						: frame.type === "cli-overwatch-launch"
							? "launch"
							: undefined;
		const response: unknown =
			frame.type === "cli-overwatch-snapshot"
				? this.snapshot
				: frame.type === "cli-overwatch-open"
					? this.openResult
					: operation === undefined || this.mutationResult !== undefined
						? this.mutationResult
						: {
								type: "cli-overwatch-mutation-result",
								operation,
								board: BOARD,
							};
		if (response instanceof Error) throw response;
		if (!accept(response)) throw new Error("stub response was not accepted");
		return response;
	}

	close(): void {
		this.closeCount += 1;
	}
}

async function runOverwatchWithClient(args: string[], client: StubClient) {
	const output: string[] = [];
	const program = new Command();
	program.exitOverride();
	const overwatch = program.command("overwatch");
	registerOverwatchCommands(overwatch, {
		connect: async () => client,
		write: async (value) => {
			output.push(value);
		},
	});

	await program.parseAsync(["node", "dg-agent", "overwatch", ...args]);
	return { client, stdout: output.join("") };
}

function runOverwatch(args: string[]) {
	return runOverwatchWithClient(args, new StubClient());
}

describe("dg-agent overwatch", () => {
	it("sends one set frame with every parsed lane field", async () => {
		const { client } = await runOverwatch([
			"set",
			"print",
			"--task",
			"Prepare launch collateral",
			"--stage",
			"e2e",
			"--mr",
			"!298",
			"--eta",
			"20m",
			"--next",
			"Approve copy",
			"--url",
			"https://claude.ai/code/session-123",
			"--background",
		]);

		expect(client.frames).toEqual([
			{
				type: "cli-overwatch-set",
				chat: "print",
				task: "Prepare launch collateral",
				stage: "e2e",
				mr: "!298",
				eta: "20m",
				next: "Approve copy",
				url: "https://claude.ai/code/session-123",
				kind: "background",
			},
		]);
		expect(client.closeCount).toBe(1);
	});

	it("sends only explicitly provided fields for a partial lane update", async () => {
		const { client } = await runOverwatch([
			"set",
			"print",
			"--stage",
			"merge",
		]);

		expect(client.frames).toEqual([
			{ type: "cli-overwatch-set", chat: "print", stage: "merge" },
		]);
	});

	it("sends an explicit clear-next lane update", async () => {
		const { client } = await runOverwatch(["set", "print", "--clear-next"]);

		expect(client.frames).toEqual([
			{ type: "cli-overwatch-set", chat: "print", clearNext: true },
		]);
	});

	it("sends one remove frame", async () => {
		const { client } = await runOverwatch(["remove", "print"]);

		expect(client.frames).toEqual([
			{ type: "cli-overwatch-remove", chat: "print" },
		]);
	});

	it("sends one merged frame", async () => {
		const { client } = await runOverwatch([
			"merged",
			"!297",
			"Add launch checklist",
		]);

		expect(client.frames).toEqual([
			{
				type: "cli-overwatch-merged",
				mr: "!297",
				title: "Add launch checklist",
			},
		]);
	});

	it("sends one launch frame", async () => {
		const { client } = await runOverwatch([
			"launch",
			"--go-live",
			"2026-10-24T14:00:00.000Z",
			"--go-no-go",
			"2026-10-17T14:00:00.000Z",
		]);

		expect(client.frames).toEqual([
			{
				type: "cli-overwatch-launch",
				goLive: "2026-10-24T14:00:00.000Z",
				goNoGo: "2026-10-17T14:00:00.000Z",
			},
		]);
	});

	it("surfaces a rejected mutation instead of reporting success", async () => {
		const client = new StubClient();
		client.mutationResult = {
			type: "error",
			message: "overwatch board already has 100 lanes",
		};

		const error = await runOverwatchWithClient(
			["set", "print"],
			client,
		).catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			exitCode: 1,
			message: "overwatch board already has 100 lanes",
		});
		expect(client.closeCount).toBe(1);
	});

	it("sends one open frame", async () => {
		const { client } = await runOverwatch(["open"]);

		expect(client.frames).toEqual([{ type: "cli-overwatch-open" }]);
	});

	it("requires an explicit successful open response", async () => {
		const client = new StubClient();
		client.openResult = new DgCliError(
			"dg-daemon did not answer the CLI request",
		);

		await expect(runOverwatchWithClient(["open"], client)).rejects.toThrow(
			"dg-daemon did not answer the CLI request",
		);
		expect(client.frames).toEqual([{ type: "cli-overwatch-open" }]);
	});

	it("surfaces the daemon error when no extension is connected", async () => {
		const client = new StubClient();
		client.openResult = {
			type: "error",
			message: "extension not connected",
		};

		const error = await runOverwatchWithClient(["open"], client).catch(
			(caught: unknown) => caught,
		);

		expect(error).toMatchObject({
			exitCode: 1,
			message: "extension not connected",
		});
	});

	it("sends one snapshot frame and prints the board as JSON", async () => {
		const { client, stdout } = await runOverwatch(["snapshot", "--json"]);

		expect(client.frames).toEqual([{ type: "cli-overwatch-snapshot" }]);
		expect(JSON.parse(stdout)).toEqual(BOARD);
	});

	it("prints a short lane table for a human snapshot", async () => {
		const { stdout } = await runOverwatch(["snapshot"]);

		expect(stdout).toContain("CHAT");
		expect(stdout).toContain("STAGE");
		expect(stdout).toContain("print");
		expect(stdout).toContain("e2e");
		expect(stdout).toContain("!298");
	});

	it("removes terminal control and bidi sequences from the human snapshot", async () => {
		const malicious = structuredClone(BOARD);
		malicious.lanes[0].mr = "!298\u001b]52;c;clipboard\u0007";
		malicious.lanes[0].eta = "now\nFORGED";
		malicious.lanes[0].next = "approve\u202ereversed";
		const client = new StubClient({
			type: "cli-overwatch-snapshot-result",
			board: malicious,
		});

		const { stdout } = await runOverwatchWithClient(["snapshot"], client);

		expect(stdout).not.toContain("\u001b");
		expect(stdout).not.toContain("\u0007");
		expect(stdout).not.toContain("\u202e");
		expect(stdout).not.toContain("\nFORGED");
		expect(stdout).toContain("now FORGED");
	});

	it("rejects an invalid stage with exit code 2 before connecting", async () => {
		const client = new StubClient();
		let connectCount = 0;
		const program = new Command();
		program.exitOverride();
		const overwatch = program.command("overwatch");
		registerOverwatchCommands(overwatch, {
			connect: async () => {
				connectCount += 1;
				return client;
			},
			write: async () => undefined,
		});

		const error = await program
			.parseAsync([
				"node",
				"dg-agent",
				"overwatch",
				"set",
				"print",
				"--stage",
				"deploying",
			])
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			exitCode: 2,
			message:
				"overwatch lane update.stage must be \"review\", \"ci\", \"e2e\", \"merge\", or \"done\"",
		});
		expect(connectCount).toBe(0);
		expect(client.frames).toEqual([]);
	});

	it("rejects an invalid lane field before connecting", async () => {
		const client = new StubClient();
		let connectCount = 0;
		const program = new Command();
		program.exitOverride();
		const overwatch = program.command("overwatch");
		registerOverwatchCommands(overwatch, {
			connect: async () => {
				connectCount += 1;
				return client;
			},
			write: async () => undefined,
		});

		const error = await program
			.parseAsync([
				"node",
				"dg-agent",
				"overwatch",
				"set",
				"print",
				"--url",
				"https://example.com/session-123",
			])
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			exitCode: 2,
			message: "overwatch lane update.url must start with \"https://claude.ai/\"",
		});
		expect(connectCount).toBe(0);
		expect(client.frames).toEqual([]);
	});

	it("rejects a launch timestamp without a timezone before connecting", async () => {
		const client = new StubClient();
		let connectCount = 0;
		const program = new Command();
		program.exitOverride();
		const overwatch = program.command("overwatch");
		registerOverwatchCommands(overwatch, {
			connect: async () => {
				connectCount += 1;
				return client;
			},
			write: async () => undefined,
		});

		const error = await program
			.parseAsync([
				"node",
				"dg-agent",
				"overwatch",
				"launch",
				"--go-live",
				"2026-10-24T14:00:00",
			])
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			exitCode: 2,
			message: "go-live must be an ISO timestamp with a timezone",
		});
		expect(connectCount).toBe(0);
	});
});
