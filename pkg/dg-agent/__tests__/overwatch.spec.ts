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
		const response: unknown =
			frame.type === "cli-overwatch-snapshot"
				? this.snapshot
				: this.openResult;
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

	it("sends one open frame", async () => {
		const { client } = await runOverwatch(["open"]);

		expect(client.frames).toEqual([{ type: "cli-overwatch-open" }]);
	});

	it("treats a quiet daemon as a successful open", async () => {
		const client = new StubClient();
		client.openResult = new DgCliError(
			"dg-daemon did not answer the CLI request",
		);

		await expect(runOverwatchWithClient(["open"], client)).resolves.toBeDefined();
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
				'overwatch lane.stage must be "review", "ci", "e2e", "merge", or "done"',
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
			message: 'overwatch lane.url must start with "https://claude.ai/"',
		});
		expect(connectCount).toBe(0);
		expect(client.frames).toEqual([]);
	});
});
