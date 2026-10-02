import {
	type CliOverwatchMutationResult,
	type CliOverwatchSetRequest,
	type CliOverwatchOpenResult,
	type CliOverwatchSnapshotResult,
	type CliRequest,
	DgCliError,
	describeError,
	isRecord,
	type OverwatchBoard,
	validateOverwatchLaneUpdate,
	validateIsoTimestamp,
} from "@dg/common";
import type { Command } from "commander";

const COMMAND_TIMEOUT_MS = 5_000;
const EXIT_INVALID_USAGE = 2;

export type OverwatchClient = {
	send(frame: CliRequest): void;
	request<T>(
		frame: CliRequest,
		accept: (value: unknown) => value is T,
		timeoutMs: number,
	): Promise<T>;
	close(): void;
};

export type OverwatchCommandDependencies = {
	connect(command: Command): Promise<OverwatchClient>;
	write(value: string): Promise<void>;
};

type SetOptions = {
	task?: string;
	stage?: string;
	mr?: string;
	eta?: string;
	next?: string;
	url?: string;
	background?: boolean;
	clearNext?: boolean;
};

type DaemonError = {
	type: "error";
	message: string;
};

type OpenResult =
	| DaemonError
	| CliOverwatchOpenResult;

function invalidUsage(error: unknown): DgCliError {
	return new DgCliError(describeError(error), EXIT_INVALID_USAGE);
}

function setRequest(chat: string, options: SetOptions): CliOverwatchSetRequest {
	try {
		const update = validateOverwatchLaneUpdate({
			chat,
			...(options.task === undefined ? {} : { task: options.task }),
			...(options.stage === undefined ? {} : { stage: options.stage }),
			...(options.mr === undefined ? {} : { mr: options.mr }),
			...(options.eta === undefined ? {} : { eta: options.eta }),
			...(options.next === undefined ? {} : { next: options.next }),
			...(options.url === undefined ? {} : { url: options.url }),
			...(options.background ? { kind: "background" as const } : {}),
			...(options.clearNext ? { clearNext: true } : {}),
		});
		return {
			type: "cli-overwatch-set",
			...update,
		};
	} catch (error) {
		throw invalidUsage(error);
	}
}

function requireField(name: string, value: string): string {
	if (value.trim().length === 0) {
		throw invalidUsage(`${name} must be a non-empty string`);
	}
	return value;
}

function requireIsoDate(name: string, value: string): string {
	try {
		return validateIsoTimestamp(value, name);
	} catch (error) {
		throw invalidUsage(error);
	}
}

function isDaemonError(value: unknown): value is DaemonError {
	return (
		isRecord(value) &&
		value.type === "error" &&
		typeof value.message === "string"
	);
}

function isOpenResult(value: unknown): value is OpenResult {
	return (
		isDaemonError(value) ||
		(isRecord(value) && value.type === "cli-overwatch-open-result")
	);
}

function isSnapshotResult(
	value: unknown,
): value is CliOverwatchSnapshotResult | DaemonError {
	if (isDaemonError(value)) return true;
	return (
		isRecord(value) &&
		value.type === "cli-overwatch-snapshot-result" &&
		isRecord(value.board) &&
		Array.isArray(value.board.lanes) &&
		Array.isArray(value.board.merges)
	);
}

function isMutationResult(
	value: unknown,
	operation: CliOverwatchMutationResult["operation"],
): value is CliOverwatchMutationResult | DaemonError {
	if (isDaemonError(value)) return true;
	return (
		isRecord(value) &&
		value.type === "cli-overwatch-mutation-result" &&
		value.operation === operation &&
		isRecord(value.board) &&
		Array.isArray(value.board.lanes) &&
		Array.isArray(value.board.merges)
	);
}

function daemonResult<T>(result: T | DaemonError): T {
	if (isDaemonError(result)) throw new DgCliError(result.message);
	return result;
}

async function mutate(
	dependencies: OverwatchCommandDependencies,
	command: Command,
	frame: CliRequest,
	operation: CliOverwatchMutationResult["operation"],
): Promise<void> {
	await request(
		dependencies,
		command,
		frame,
		(value): value is CliOverwatchMutationResult | DaemonError =>
			isMutationResult(value, operation),
	);
}

async function request<T>(
	dependencies: OverwatchCommandDependencies,
	command: Command,
	frame: CliRequest,
	accept: (value: unknown) => value is T | DaemonError,
): Promise<T> {
	const client = await dependencies.connect(command);
	try {
		const result = await client.request(frame, accept, COMMAND_TIMEOUT_MS);
		return daemonResult(result);
	} finally {
		client.close();
	}
}

async function openBoard(
	dependencies: OverwatchCommandDependencies,
	command: Command,
): Promise<void> {
	await request(
		dependencies,
		command,
		{ type: "cli-overwatch-open" },
		isOpenResult,
	);
}

function terminalText(value: string): string {
	return value
		.replace(
			/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
			" ",
		)
		.replace(/\s+/g, " ")
		.trim();
}

function renderTable(board: OverwatchBoard): string {
	if (board.lanes.length === 0) return "No overwatch lanes.\n";
	const headings = ["CHAT", "STAGE", "MR", "ETA", "NEXT"];
	const rows = board.lanes.map((lane) => [
		terminalText(lane.chat),
		terminalText(lane.stage),
		terminalText(lane.mr ?? ""),
		terminalText(lane.eta ?? ""),
		terminalText(lane.next ?? ""),
	]);
	const widths = headings.map((heading, index) =>
		Math.max(heading.length, ...rows.map((row) => row[index].length)),
	);
	return `${[headings, ...rows]
		.map((row) =>
			row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd(),
		)
		.join("\n")}\n`;
}

export function registerOverwatchCommands(
	overwatch: Command,
	dependencies: OverwatchCommandDependencies,
): void {
	overwatch.description("publish and inspect the live overwatch board");

	overwatch
		.command("set")
		.description("create a lane or update only the provided fields")
		.argument("<chat>", "chat name")
		.option("--task <task>", "short task summary; defaults to chat for a new lane")
		.option(
			"--stage <stage>",
			"review, ci, e2e, merge, or done; required for a new lane",
		)
		.option("--mr <mr>", "merge request reference")
		.option("--eta <eta>", "estimated completion")
		.option("--next <next>", "next action needed")
		.option("--clear-next", "remove the current next action")
		.option("--url <url>", "claude.ai chat URL")
		.option("--background", "mark a new or existing lane as a background agent")
		.action(async (chat: string, options: SetOptions, command: Command) => {
			await mutate(
				dependencies,
				command,
				setRequest(chat, options),
				"set",
			);
		});

	overwatch
		.command("remove")
		.description("remove a chat lane")
		.argument("<chat>", "chat name")
		.action(async (chat: string, _options: unknown, command: Command) => {
			await mutate(
				dependencies,
				command,
				{
					type: "cli-overwatch-remove",
					chat: requireField("chat", chat),
				},
				"remove",
			);
		});

	overwatch
		.command("merged")
		.description("record a merge completed today")
		.argument("<mr>", "merge request reference")
		.argument("<title>", "merge title")
		.action(
			async (
				mr: string,
				title: string,
				_options: unknown,
				command: Command,
			) => {
				await mutate(
					dependencies,
					command,
					{
						type: "cli-overwatch-merged",
						mr: requireField("mr", mr),
						title: requireField("title", title),
					},
					"merged",
				);
			},
		);

	overwatch
		.command("launch")
		.description("set launch milestones")
		.requiredOption("--go-live <iso>", "go-live date and time")
		.option("--go-no-go <iso>", "go/no-go date and time")
		.action(
			async (
				options: { goLive: string; goNoGo?: string },
				command: Command,
			) => {
				await mutate(
					dependencies,
					command,
					{
						type: "cli-overwatch-launch",
						goLive: requireIsoDate("go-live", options.goLive),
						...(options.goNoGo === undefined
							? {}
							: { goNoGo: requireIsoDate("go-no-go", options.goNoGo) }),
					},
					"launch",
				);
			},
		);

	overwatch
		.command("open")
		.description("open or focus the overwatch board")
		.action(async (_options: unknown, command: Command) => {
			await openBoard(dependencies, command);
		});

	overwatch
		.command("snapshot")
		.description("print the current overwatch board")
		.option("--json", "print machine-readable board JSON")
		.action(async (options: { json?: boolean }, command: Command) => {
			const result = await request(
				dependencies,
				command,
				{ type: "cli-overwatch-snapshot" },
				isSnapshotResult,
			);
			await dependencies.write(
				options.json
					? `${JSON.stringify(result.board)}\n`
					: renderTable(result.board),
			);
		});
}
