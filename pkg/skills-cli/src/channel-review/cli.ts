import { existsSync, readFileSync } from "node:fs";
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
import { runSubtree } from "../utils/lazy-command";
import {
	CONNECT_PROVIDERS,
	type ConnectFlags,
	type ConnectProvider,
	runConnect,
} from "./connect";
import { type MigrateFlags, runMigrateEnv } from "./migrate";
import { defaultSetupDeps, runSetup, type SetupFlags } from "./setup";

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

/** Offers setup on a terminal when the config is missing; false means stop. */
async function ensureConfig(): Promise<boolean> {
	const deps = defaultSetupDeps();
	if (existsSync(deps.configPath) || !deps.isTTY) return true;
	const answer = (await deps.ask("No channel-review config yet. Run setup now? [Y/n]: ")).trim().toLowerCase();
	if (answer !== "" && !answer.startsWith("y")) return true;
	process.exitCode = await runSetup({}, deps);
	return process.exitCode === 0;
}

async function runDaemon(flags: RunFlags): Promise<void> {
	if (!(await ensureConfig())) return;
	const configPath = channelReviewPaths("dev").configPath;
	const config = loadConfig(configPath);
	const env = resolveEnv(config, flags.env);
	const controller = new AbortController();
	for (const name of ["SIGTERM", "SIGINT"] as const) {
		process.on(name, () => controller.abort());
	}
	process.exitCode = await serve({
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
}

export function registerChannelReview(program: Command): void {
	const command = program
		.command("channel-review")
		.description(
			"Run /thrash on pull requests posted in a Teams chat through a local daemon.",
		);
	command.addCommand(registerEmojis({ io }));

	command
		.command("setup")
		.description("create the config file by answering a few questions")
		.option("--force", "replace an existing config file")
		.action(async (flags: SetupFlags) => {
			process.exitCode = await runSetup(flags);
		});

	command
		.command("start")
		.description("start the review daemon in the background")
		.addOption(envOption())
		.addOption(runnerOption())
		.addOption(chatIdOption())
		.action(async (flags: RunFlags) => {
			if (!(await ensureConfig())) return;
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
		.command("connect")
		.description(
			"store a Datadog token, Sentry token or relay secret in the dg credential store; values are never printed",
		)
		.addArgument(
			new Argument("<provider>", "secret to store").choices(CONNECT_PROVIDERS),
		)
		.addOption(envOption())
		.option(
			"--site <site>",
			"Datadog site such as us5.datadoghq.com, or the Sentry base URL",
		)
		.option("--org <slug>", "Sentry organization slug")
		.option(
			"--paste",
			"open the token page in the default browser and paste the token",
		)
		.option("--session <id>", "dg session to authenticate with")
		.action(async (provider: ConnectProvider, flags: ConnectFlags) => {
			await runConnect(provider, flags);
		});

	command
		.command("migrate-env")
		.description(
			"move channel-review secrets from a .env file into the dg credential store",
		)
		.option(
			"--file <path>",
			"env file (default: .env next to the mise config in the current folder)",
		)
		.option("--dry-run", "list the variables that would move")
		.option(
			"--keep-backup",
			"write a plain-text 0600 .env.bak-<timestamp> copy with the original values",
		)
		.option("--session <id>", "dg session to authenticate with")
		.action(async (flags: MigrateFlags) => {
			await runMigrateEnv(flags);
		});

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

export function main(argv: string[]): Promise<void> {
	return runSubtree("channel-review", registerChannelReview, argv);
}
