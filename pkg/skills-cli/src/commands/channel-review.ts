import { readFileSync } from "node:fs";
import {
	channelReviewPaths,
	createSystemPlatform,
	type DaemonIo,
	ENV_NAMES,
	type EnvName,
	loadConfig,
	logs,
	RUNNER_NAMES,
	registerEmojis,
	resolveEnv,
	saveDefaultEnv,
	serve,
	start,
	status,
	stop,
} from "@dg/channel-review";
import { describeError, isRecord } from "@dg/common";
import { Argument, type Command, Option } from "commander";

type RunFlags = {
	env?: EnvName;
	runner?: (typeof RUNNER_NAMES)[number];
	chatId?: string;
};

type LogsFlags = { env?: EnvName; lines: number; follow?: boolean };

const io: DaemonIo = {
	out: (line) => console.log(line),
	err: (line) => console.error(line),
};

const envOption = () =>
	new Option(
		"--env <env>",
		"environment (default: the saved env)",
	).choices(ENV_NAMES);

const runnerOption = () =>
	new Option("--runner <runner>", "agent CLI that runs the review").choices(
		RUNNER_NAMES,
	);

const chatIdOption = () =>
	new Option("--chat-id <id>", "chat id to watch instead of the topic lookup");

function stamped(write: (line: string) => void, level: string) {
	return (message: string) =>
		write(`${new Date().toISOString()} ${level} ${message}`);
}

function rawDefaultEnv(path: string): unknown {
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(raw) && isRecord(raw.env) ? raw.env.default : undefined;
	} catch {
		return undefined;
	}
}

function printSavedEnv(path: string): void {
	try {
		const env = resolveEnv(loadConfig(path));
		io.out(`default env: ${env.name}`);
		io.out(`base URL: ${env.baseUrl}`);
		io.out(`AWS profile: ${env.awsProfile}`);
	} catch (error) {
		const saved = rawDefaultEnv(path);
		io.out(`default env: ${ENV_NAMES.find((candidate) => candidate === saved) ?? "dev"}`);
		io.err(describeError(error));
	}
}

async function runDaemon(flags: RunFlags): Promise<void> {
	const configPath = channelReviewPaths("dev").configPath;
	const config = loadConfig(configPath);
	const env = resolveEnv(config, flags.env);
	const controller = new AbortController();
	for (const name of ["SIGTERM", "SIGINT"] as const) {
		process.on(name, () => controller.abort());
	}
	const code = await serve({
		config,
		env,
		paths: channelReviewPaths(env.name),
		overrides: { runner: flags.runner, chatId: flags.chatId },
		log: {
			info: stamped((line) => console.log(line), "INFO"),
			warn: stamped((line) => console.error(line), "WARN"),
			error: stamped((line) => console.error(line), "ERROR"),
		},
		seams: {},
		platform: createSystemPlatform(),
		signal: controller.signal,
	});
	process.exit(code);
}

export function registerChannelReview(program: Command): void {
	const command = program
		.command("channel-review")
		.description(
			"Run /thrash on pull requests posted in a Teams chat through a local daemon.",
		);
	command.addCommand(registerEmojis({ io }));

	command
		.command("start")
		.description("start the review daemon in the background")
		.addOption(envOption())
		.addOption(runnerOption())
		.addOption(chatIdOption())
		.action(async (flags: RunFlags) => {
			process.exitCode = await start(flags, {
				platform: createSystemPlatform(),
				io,
			});
		});

	command
		.command("stop")
		.description("stop the review daemon")
		.addOption(envOption())
		.action(async (flags: RunFlags) => {
			process.exitCode = await stop(flags, {
				platform: createSystemPlatform(),
				io,
			});
		});

	command
		.command("status")
		.description(
			"print the daemon state, runner probes, and a preflight check as JSON",
		)
		.addOption(envOption())
		.action(async (flags: RunFlags) => {
			process.exitCode = await status(flags, {
				platform: createSystemPlatform(),
				io,
			});
		});

	command
		.command("logs")
		.description("print the last lines of the daemon log")
		.addOption(envOption())
		.addOption(
			new Option("-n, --lines <n>", "number of lines to print")
				.default(40)
				.argParser(Number),
		)
		.option("-f, --follow", "keep printing new lines until Ctrl+C")
		.action(async (flags: LogsFlags) => {
			const controller = new AbortController();
			process.once("SIGINT", () => controller.abort());
			process.exitCode = await logs(flags, { io, signal: controller.signal });
		});

	command
		.command("run")
		.description("run the review daemon in the foreground")
		.addOption(envOption())
		.addOption(runnerOption())
		.addOption(chatIdOption())
		.action(runDaemon);

	command
		.command("env")
		.description(
			"print the default environment, or save dev or prod as the default",
		)
		.addArgument(
			new Argument("[name]", "environment").choices(ENV_NAMES),
		)
		.action((name: EnvName | undefined) => {
			const path = channelReviewPaths("dev").configPath;
			if (name === undefined) {
				printSavedEnv(path);
				return;
			}
			saveDefaultEnv(path, name);
			io.out(`default env: ${name}`);
		});
}
