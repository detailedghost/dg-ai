import { readFileSync } from "node:fs";
import { DgCliError, isRecord } from "@dg/common";
import type { SystemSeams } from "@dg/common/node";
import { Argument, Command, Option } from "commander";
import {
	type ChannelConfig,
	ENV_NAMES,
	loadConfig,
	REACTION_DEFAULTS,
	resolveEnv,
	SLOT_KEYS,
	type Slot,
	saveReactionSlot,
} from "./config";
import {
	connect,
	createSystemPlatform,
	type DaemonIo,
	isOurDaemon,
	readPidRecord,
} from "./daemon";
import type { Log } from "./engine";
import { channelReviewPaths } from "./paths";
import { capturedReactionId } from "./reactions";

const slots = Object.keys(SLOT_KEYS);
type ResolvedEnv = ReturnType<typeof resolveEnv>;
type DaemonRunning = (pidPath: string) => Promise<boolean>;

async function daemonRunning(pidPath: string): Promise<boolean> {
	const record = readPidRecord(pidPath);
	return record !== undefined && (await isOurDaemon(record.pid, createSystemPlatform()));
}

async function restartNotice(
	pidPath: string,
	running: DaemonRunning,
	io: DaemonIo,
): Promise<void> {
	if (await running(pidPath)) io.out("restart the daemon to apply");
}

export async function captureEmoji({
	config,
	env,
	slot,
	chatId,
	configPath,
	timeoutMs = 120_000,
	io,
	log,
	system = {},
	seams = {},
}: {
	config: ChannelConfig;
	env: ResolvedEnv;
	slot: Slot;
	chatId?: string;
	configPath: string;
	timeoutMs?: number;
	io: DaemonIo;
	log: Log;
	system?: SystemSeams;
	seams?: {
		connect?: typeof connect;
		now?: () => Date;
		daemonRunning?: DaemonRunning;
	};
}): Promise<number> {
	const { provider, chats } = await (seams.connect ?? connect)({
		config: { ...config, chats: config.chats.slice(0, 1) },
		env,
		overrides: { chatId },
		seams: {},
		log,
	});
	const [chat] = chats;
	const startedAt = (seams.now ?? (() => new Date()))().getTime();
	const controller = new AbortController();
	const abort = () => controller.abort();
	const canceled = new Promise<undefined>((resolve) => {
		controller.signal.addEventListener("abort", () => resolve(undefined), {
			once: true,
		});
	});
	const prompt = Promise.withResolvers<string[]>();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		abort();
	}, timeoutMs);
	process.once("SIGINT", abort);

	async function consume(): Promise<string | undefined> {
		for await (const event of provider.subscribe({
			chatId: chat.id,
			signal: controller.signal,
		})) {
			if (event.type !== "reaction") continue;
			const ids = await prompt.promise;
			if (controller.signal.aborted) return undefined;
			const id = capturedReactionId(event.reaction, {
				messageIds: ids,
				since: startedAt,
				log,
			});
			if (id !== undefined) return id;
		}
		return canceled;
	}

	try {
		const id = await Promise.race([
			Promise.all([
				consume(),
				provider
					.reply({
						chatId: chat.id,
						text: `${env.botName} needs the ${slot} emoji: react to this message with it within ${timeoutMs / 1000} seconds`,
					})
					.then(({ messageIds }) => {
						prompt.resolve(messageIds);
						if (messageIds.length === 0) {
							io.err(
								`the relay returned no message id for the prompt; use emojis set ${slot} <id>`,
							);
							abort();
						}
					}),
			]).then(([id]) => id),
			canceled,
		]);
		if (id === undefined || controller.signal.aborted) {
			if (timedOut) {
				io.err(
					`${slot}: no reaction event received; the fallback id stays in place; use emojis set ${slot} <id>`,
				);
			}
			return 1;
		}
		abort();
		clearTimeout(timer);
		saveReactionSlot(configPath, SLOT_KEYS[slot], id);
		io.out(`${slot}: ${id}`);
		await restartNotice(
			channelReviewPaths(env.name, system).pidPath,
			seams.daemonRunning ?? daemonRunning,
			io,
		);
		return 0;
	} finally {
		abort();
		prompt.resolve([]);
		clearTimeout(timer);
		process.off("SIGINT", abort);
	}
}

export function showSlots(config: ChannelConfig, io: DaemonIo): void {
	for (const [slot, key] of Object.entries(SLOT_KEYS)) {
		const id = config.reactions[key];
		io.out(
			`${slot}: ${id}${id === REACTION_DEFAULTS[key] ? " (built-in fallback)" : ""}`,
		);
	}
}

export function registerEmojis({
	io,
	system = {},
	capture = captureEmoji,
	daemonRunning: running = daemonRunning,
	exit = (code) => {
		process.exitCode = code;
	},
}: {
	io: DaemonIo;
	system?: SystemSeams;
	capture?: typeof captureEmoji;
	daemonRunning?: DaemonRunning;
	exit?: (code: number) => void;
}): Command {
	const command = new Command("emojis").description(
		"discover and configure custom reaction emojis",
	);
	command.exitOverride((error) => {
		if (error.exitCode !== 0) throw error;
	});
	const configPath = channelReviewPaths("dev", system).configPath;
	command
		.command("capture")
		.description("capture a custom emoji from a reaction to a prompt from the bot")
		.addOption(
			new Option("--slot <slot>", "reaction slot")
				.choices(slots)
				.makeOptionMandatory(),
		)
		.addOption(
			new Option(
				"--env <env>",
				"environment (default: the saved env)",
			).choices(ENV_NAMES),
		)
		.option("--chat-id <id>", "chat id to use instead of the topic lookup")
		.option("--timeout <seconds>", "capture timeout in seconds", "120")
		.action(
			async (flags: {
				slot: Slot;
				env?: string;
				chatId?: string;
				timeout: string;
			}) => {
				const timeoutMs = Number(flags.timeout) * 1000;
				if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
					throw new DgCliError(
						"--timeout must be a positive number of seconds",
					);
				}
				const config = loadConfig(configPath);
				exit(
					await capture({
						config,
						env: resolveEnv(config, flags.env),
						slot: flags.slot,
						chatId: flags.chatId,
						configPath,
						timeoutMs,
						io,
						log: { info: io.err, warn: io.err, error: io.err },
						system,
						seams: { daemonRunning: running },
					}),
				);
			},
		);
	command
		.command("set")
		.description("save a custom emoji id for a reaction slot")
		.addArgument(new Argument("<slot>", "reaction slot").choices(slots))
		.argument("<id>", "custom reaction id")
		.action(async (slot: Slot, id: string) => {
			saveReactionSlot(configPath, SLOT_KEYS[slot], id);
			io.out(`${slot}: ${id}`);
			const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
			const name =
				isRecord(raw) && isRecord(raw.env) && raw.env.default === "prod"
					? "prod"
					: "dev";
			await restartNotice(
				channelReviewPaths(name, system).pidPath,
				running,
				io,
			);
		});
	command
		.command("show")
		.description("show reaction slots and their built-in fallbacks")
		.action(() => showSlots(loadConfig(configPath), io));
	return command;
}
