import {
	type CliOverwatchSetRequest,
	type CliOverwatchSnapshotResult,
	type CliRequest,
	DgCliError,
	describeError,
	isRecord,
	type OverwatchBoard,
	validateOverwatchLane,
} from "@dg/common";
import type { Command } from "commander";

const COMMAND_TIMEOUT_MS = 5_000;
const OPEN_ERROR_WINDOW_MS = 250;
const EXIT_INVALID_USAGE = 2;
const NO_DAEMON_ANSWER = "dg-daemon did not answer the CLI request";

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
};

type DaemonError = {
	type: "error";
	message: string;
};

type OpenResult =
	| DaemonError
	| { type: "cli-overwatch-open-result" }
	| { type: "overwatch-open" };

function invalidUsage(error: unknown): DgCliError {
	return new DgCliError(describeError(error), EXIT_INVALID_USAGE);
}

function setRequest(chat: string, options: SetOptions): CliOverwatchSetRequest {
	try {
		const lane = validateOverwatchLane({
			chat,
			task: options.task ?? chat,
			stage: options.stage ?? "review",
			...(options.mr === undefined ? {} : { mr: options.mr }),
			...(options.eta === undefined ? {} : { eta: options.eta }),
			...(options.next === undefined ? {} : { next: options.next }),
			...(options.url === undefined ? {} : { url: options.url }),
			kind: options.background ? "background" : "chat",
			publisher: "dg-agent",
			updatedAt: "pending",
		});
		return {
			type: "cli-overwatch-set",
			chat: lane.chat,
			task: lane.task,
			stage: lane.stage,
			...(lane.mr === undefined ? {} : { mr: lane.mr }),
			...(lane.eta === undefined ? {} : { eta: lane.eta }),
			...(lane.next === undefined ? {} : { next: lane.next }),
			...(lane.url === undefined ? {} : { url: lane.url }),
			kind: lane.kind,
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
	requireField(name, value);
	if (Number.isNaN(Date.parse(value))) {
		throw invalidUsage(`${name} must be a valid ISO date`);
	}
	return value;
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
		(isRecord(value) &&
			(value.type === "cli-overwatch-open-result" ||
				value.type === "overwatch-open"))
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

function daemonResult<T>(result: T | DaemonError): T {
	if (isDaemonError(result)) throw new DgCliError(result.message);
	return result;
}

async function send(
	dependencies: OverwatchCommandDependencies,
	command: Command,
	frame: CliRequest,
): Promise<void> {
	const client = await dependencies.connect(command);
	try {
		client.send(frame);
	} finally {
		client.close();
	}
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
	const client = await dependencies.connect(command);
	try {
		try {
			const result = await client.request(
				{ type: "cli-overwatch-open" },
				isOpenResult,
				OPEN_ERROR_WINDOW_MS,
			);
			daemonResult(result);
		} catch (error) {
			if (!(error instanceof DgCliError && error.message === NO_DAEMON_ANSWER)) {
				throw error;
			}
		}
	} finally {
		client.close();
	}
}

function renderTable(board: OverwatchBoard): string {
	if (board.lanes.length === 0) return "No overwatch lanes.\n";
	const headings = ["CHAT", "STAGE", "MR", "ETA", "NEXT"];
	const rows = board.lanes.map((lane) => [
		lane.chat,
		lane.stage,
		lane.mr ?? "",
		lane.eta ?? "",
		lane.next ?? "",
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
		.description("create or update a chat lane")
		.argument("<chat>", "chat name")
		.option("--task <task>", "short task summary")
		.option("--stage <stage>", "review, ci, e2e, merge, or done")
		.option("--mr <mr>", "merge request reference")
		.option("--eta <eta>", "estimated completion")
		.option("--next <next>", "next action needed")
		.option("--url <url>", "claude.ai chat URL")
		.option("--background", "mark the lane as a background agent")
		.action(async (chat: string, options: SetOptions, command: Command) => {
			await send(dependencies, command, setRequest(chat, options));
		});

	overwatch
		.command("remove")
		.description("remove a chat lane")
		.argument("<chat>", "chat name")
		.action(async (chat: string, _options: unknown, command: Command) => {
			await send(dependencies, command, {
				type: "cli-overwatch-remove",
				chat: requireField("chat", chat),
			});
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
				await send(dependencies, command, {
					type: "cli-overwatch-merged",
					mr: requireField("mr", mr),
					title: requireField("title", title),
				});
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
				await send(dependencies, command, {
					type: "cli-overwatch-launch",
					goLive: requireIsoDate("go-live", options.goLive),
					...(options.goNoGo === undefined
						? {}
						: { goNoGo: requireIsoDate("go-no-go", options.goNoGo) }),
				});
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
