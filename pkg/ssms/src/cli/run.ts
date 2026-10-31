import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { applyCleanup, conversationToClassifiable, planCleanup } from "../cleanup/apply";
import { parseCleanupConfig } from "../config/parse";
import { defaultCleanupConfig, type SmsCleanupConfig } from "../config/types";
import {
	ConfirmationRequired,
	HookSendRefused,
	SendDeclined,
	UnsupportedCapability,
} from "../errors";
import type { MessagesBrowser } from "../google/browser";
import { createGoogleProvider } from "../google/provider";
import { createLogger, type LogEvent } from "../privacy/log";
import { redactSecrets } from "../privacy/redact";
import { decideSend, hookEnvName } from "../safety/send-gate";
import { startSignalDaemon, type Spawned } from "../signal/daemon";
import { resolveSignalBinary } from "../signal/hint";
import { createSignalProvider } from "../signal/provider";
import { renderQr } from "../signal/qr";
import type { RpcTransport } from "../signal/rpc";
import type { SmsProvider, SmsProviderId } from "../types";
import { PROVIDER_NAMES, renderHelp } from "./catalog";
import { parseArgs, UsageError, type ParsedArgs } from "./parse";

const VERBS = [
	"link",
	"status",
	"list",
	"read",
	"receive",
	"watch",
	"archive",
	"block-report",
	"draft",
	"send",
	"classify",
	"cleanup",
] as const;

export interface SsmsRuntime {
	home?: string;
	env?: NodeJS.ProcessEnv;
	browser?: MessagesBrowser;
	openBrowser?: () => Promise<MessagesBrowser>;
	rpc?: RpcTransport;
	openRpc?: () => Promise<{ transport: RpcTransport; stop: () => Promise<void> }>;
	which?: (name: string) => string | null;
	exists?: (path: string) => boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	rng?: () => number;
	ids?: () => string;
	stdinIsTTY?: boolean;
	ask?: (draftId: string) => Promise<boolean>;
	stdio?: "inherit";
	spawn?: (cmd: string[]) => Spawned;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function isProvider(value: string | undefined): value is SmsProviderId {
	return (PROVIDER_NAMES as readonly string[]).includes(value ?? "");
}

function loadConfig(path: string | undefined): SmsCleanupConfig {
	if (!path) return defaultCleanupConfig();
	const text = readFileSync(path, "utf8");
	const value = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
	return parseCleanupConfig(value);
}

export async function runSsms(
	argv: readonly string[],
	runtime: SsmsRuntime = {},
): Promise<RunResult> {
	let stdout = "";
	let stderr = "";
	const writeOut = (text: string) => {
		stdout += text;
		if (runtime.stdio === "inherit") process.stdout.write(text);
	};
	const writeErr = (text: string) => {
		stderr += text;
		if (runtime.stdio === "inherit") process.stderr.write(text);
	};
	const log = createLogger((line) => writeErr(`${line}\n`));
	let stop: (() => Promise<void>) | undefined;
	let opened: MessagesBrowser | undefined;
	try {
		const args = parseArgs(argv);
		if (args.help || argv.length === 0) {
			writeOut(renderHelp());
			return { code: 0, stdout, stderr };
		}
		if (!isProvider(args.provider)) {
			throw new UsageError(`provider must be one of ${PROVIDER_NAMES.join(", ")}`);
		}
		if (!args.verb) throw new UsageError("verb is required");
		if (args.verb === "delete") throw new UsageError("delete is disabled");
		if (!VERBS.includes(args.verb as (typeof VERBS)[number])) {
			throw new UsageError(`unknown verb ${args.verb}`);
		}
		const home =
			runtime.home ?? runtime.env?.DG_HOME ?? process.env.DG_HOME ?? join(homedir(), ".dg");
		const env = runtime.env ?? process.env;
		const config = loadConfig(args.config);
		const session = await openSession(args.provider, runtime, home, env, config, log, args.verb);
		stop = session.stop;
		opened = session.opened;
		await dispatch(args, session.provider, config, runtime, env, writeOut, log);
		return { code: 0, stdout, stderr };
	} catch (error) {
		const message = redactSecrets(error instanceof Error ? error.message : String(error));
		writeErr(`${message}\n`);
		if (error instanceof UnsupportedCapability) {
			log({
				id: error.provider,
				reason: "unsupported",
				provider: error.provider,
				verb: error.capability,
			});
		}
		return { code: error instanceof UsageError ? 2 : 1, stdout, stderr };
	} finally {
		await opened?.close().catch(() => undefined);
		await stop?.().catch(() => undefined);
	}
}

async function openSession(
	id: SmsProviderId,
	runtime: SsmsRuntime,
	home: string,
	env: NodeJS.ProcessEnv,
	config: SmsCleanupConfig,
	log: (event: LogEvent) => void,
	verb: string,
): Promise<{ provider: SmsProvider; stop?: () => Promise<void>; opened?: MessagesBrowser }> {
	if (id === "google") {
		const browser = await googleBrowser(runtime);
		return {
			provider: createGoogleProvider({
				browser,
				home,
				config,
				log,
				now: runtime.now,
				sleep: runtime.sleep,
				rng: runtime.rng,
				ids: runtime.ids,
			}),
			opened: runtime.browser ? undefined : browser,
		};
	}
	const transport = await signalTransport(runtime, home, env, log, verb);
	return {
		provider: createSignalProvider({
			home,
			rpc: transport.transport,
			log,
			now: runtime.now,
			rng: runtime.rng,
			ids: runtime.ids,
		}),
		stop: transport.stop,
	};
}

async function googleBrowser(runtime: SsmsRuntime): Promise<MessagesBrowser> {
	if (runtime.browser) return runtime.browser;
	if (runtime.openBrowser) return runtime.openBrowser();
	throw new Error("google needs the dg-skills browser launcher");
}

async function signalTransport(
	runtime: SsmsRuntime,
	home: string,
	env: NodeJS.ProcessEnv,
	log: (event: LogEvent) => void,
	verb: string,
): Promise<{ transport: RpcTransport; stop: () => Promise<void> }> {
	if (runtime.rpc) return { transport: runtime.rpc, stop: async () => undefined };
	if (runtime.openRpc) return runtime.openRpc();
	let binary: string;
	try {
		binary = resolveSignalBinary(
			env,
			runtime.which ?? ((name) => Bun.which(name)),
			runtime.exists ?? existsSync,
		);
	} catch (error) {
		log({ id: "signal-cli", reason: "missing-binary", provider: "signal", verb });
		throw error;
	}
	const dataDir = join(home, "ssms", "signal-data");
	mkdirSync(dataDir, { recursive: true });
	const spawn =
		runtime.spawn ??
		((cmd: string[]) => Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" }));
	const started = await startSignalDaemon({ binary, dataDir, spawn });
	log({ id: `port:${started.port}`, reason: "daemon-start", provider: "signal", verb });
	return { transport: started.transport, stop: started.stop };
}

async function dispatch(
	args: ParsedArgs,
	provider: SmsProvider,
	config: SmsCleanupConfig,
	runtime: SsmsRuntime,
	env: NodeJS.ProcessEnv,
	writeOut: (text: string) => void,
	log: (event: LogEvent) => void,
): Promise<void> {
	const emit = (payload: unknown, human: string) => {
		writeOut(args.json ? `${JSON.stringify(payload)}\n` : human);
	};
	const verb = args.verb ?? "";
	if (verb === "link") {
		const result = await provider.link({
			deviceName: args.name,
			onUri: async (uri) => {
				writeOut(`${await renderQr(uri)}${uri}\n`);
			},
		});
		emit(
			{
				ok: true,
				provider: provider.id,
				reason: result.reason,
				accountId: result.accountId,
				deviceName: result.deviceName,
				linked: result.linked,
			},
			`linked: ${result.linked}\naccount: ${result.accountId}\nreason: ${result.reason}\n`,
		);
		return;
	}
	if (verb === "status") {
		const result = await provider.status();
		emit(
			result,
			`linked: ${result.linked}\naccounts: ${result.accountIds.join(",")}\nreason: ${result.reason}\n`,
		);
		return;
	}
	if (verb === "list") {
		const rows = await provider.listConversations();
		emit(
			{ ok: true, conversations: rows },
			`${rows.map((row) => `${row.id}\t${row.kind}\t${row.title}`).join("\n")}\n`,
		);
		return;
	}
	if (verb === "read") {
		if (!args.conversation) throw new UsageError("read needs a conversation id");
		const messages = await provider.readRecent(args.conversation, args.limit ?? 20);
		emit(
			{ ok: true, messages },
			`${messages.map((item) => `${item.id}\t${item.timestamp}\t${item.text ?? ""}`).join("\n")}\n`,
		);
		return;
	}
	if (verb === "receive" || verb === "watch") {
		const messages = await provider.receive({
			limit: args.limit ?? 20,
			timeoutMs: args.timeoutMs ?? (verb === "watch" ? 60_000 : 0),
			conversationId: args.conversation,
		});
		emit(
			{ ok: true, messages },
			`${messages.map((item) => `${item.id}\t${item.timestamp}\t${item.text ?? ""}`).join("\n")}\n`,
		);
		return;
	}
	if (verb === "archive" || verb === "block-report") {
		if (!args.conversation) throw new UsageError(`${verb} needs a conversation id`);
		if (args.dryRun || config.dry_run) {
			log({ id: args.conversation, reason: "dry-run", provider: provider.id, verb });
			emit(
				{ ok: true, dryRun: true, conversationId: args.conversation, verb },
				`dry-run ${verb} ${args.conversation}\n`,
			);
			return;
		}
		const result =
			verb === "archive"
				? await provider.archive({ conversationId: args.conversation })
				: await provider.blockAndReportSpam({ conversationId: args.conversation });
		emit(result, `${result.reason} ${result.conversationId}\n`);
		return;
	}
	if (verb === "draft") {
		if (!args.conversation) throw new UsageError("draft needs --conversation");
		const draft = await provider.draftReply({
			conversationId: args.conversation,
			text: args.text,
			emoji: args.emoji,
			remove: args.remove,
			targetTimestamp: args.targetTimestamp,
			targetAuthorId: args.targetAuthor,
			attachments: args.attachments.map((path) => ({
				path,
				contentType: contentType(path),
			})),
			quote:
				args.quoteTimestamp === undefined
					? undefined
					: {
							authorId: args.quoteAuthor ?? "",
							timestamp: args.quoteTimestamp,
							text: args.quoteText,
						},
		});
		const body = [
			args.text ? `text: ${args.text}` : "",
			args.emoji ? `emoji: ${args.emoji}` : "",
			args.attachments.length ? `attachments: ${args.attachments.join(", ")}` : "",
			args.quoteTimestamp !== undefined ? `quote: ${args.quoteTimestamp}` : "",
		]
			.filter(Boolean)
			.join("\n");
		emit(
			{ ok: true, draft },
			`draft ${draft.id}\nprovider: ${draft.provider}\nconversation: ${draft.conversationId}\n${body}\nconfirm: ssms ${provider.id} send --draft ${draft.id} --yes\n`,
		);
		return;
	}
	if (verb === "send") {
		if (!args.draft) throw new UsageError("send needs --draft ID");
		const decision = await decideSend({
			yes: args.yes,
			hook: hookEnvName(env) !== undefined,
			tty: runtime.stdinIsTTY === true,
			draftId: args.draft,
			ask: runtime.ask,
		});
		if (!decision.ok) {
			log({ id: args.draft, reason: "send-refused", provider: provider.id, verb: "send" });
			if (decision.reason === "hook") throw new HookSendRefused();
			if (decision.reason === "declined") throw new SendDeclined();
			throw new ConfirmationRequired();
		}
		const result = await provider.sendDraft({
			draftId: args.draft,
			confirmed: true,
			hook: hookEnvName(env) !== undefined,
		});
		emit(result, `sent ${result.draftId}\n`);
		return;
	}
	if (verb === "classify" || verb === "cleanup") {
		if (provider.id !== "google") throw new UsageError(`${verb} is a google verb`);
		const rows = await provider.listConversations();
		if (verb === "classify") {
			const plan = planCleanup(rows.map(conversationToClassifiable), config);
			emit(
				{ ok: true, plan },
				`${plan.map((item) => `${item.id}\t${item.disposition}\t${item.reason}`).join("\n")}\n`,
			);
			return;
		}
		const actions = await applyCleanup(provider, rows, config, args.dryRun);
		log({ id: String(actions.length), reason: "cleanup", provider: "google", verb: "cleanup" });
		emit(
			{ ok: true, actions, allowDelete: config.allow_delete, deleted: 0 },
			`${actions
				.map((item) => `${item.id}\t${item.disposition}\t${item.reason}\tapplied=${item.applied}`)
				.join("\n")}\n`,
		);
		return;
	}
	throw new UsageError(`unknown verb ${verb}`);
}

function contentType(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	return "application/octet-stream";
}

if (import.meta.main) {
	const result = await runSsms(process.argv.slice(2), { stdio: "inherit" });
	process.exit(result.code);
}
