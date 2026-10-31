import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { applyCleanup, conversationToClassifiable, planCleanup } from "../cleanup/apply";
import { parseCleanupConfig } from "../config/parse";
import { defaultCleanupConfig, type SmsCleanupConfig } from "../config/types";
import { SendDeclined, UnsupportedCapability } from "../errors";
import type { MessagesBrowser } from "../google/browser";
import { createGoogleProvider } from "../google/provider";
import { draftPath, readDraft, writeDraft } from "../drafts/store";
import { createLogger, type LogEvent } from "../privacy/log";
import { redactSecrets } from "../privacy/redact";
import { authorizeSend, isHookEnv } from "./authorize";
import { hashToken } from "../safety/token";
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
	revealToken?: (draftId: string, token: string) => void;
	openTerminal?: (path: string, flags: string) => number;
	configHome?: string;
	passwdHome?: string | null;
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

function runAccountCommand(command: string, args: string[]): string {
	return execFileSync(command, args, { encoding: "utf8", timeout: 1000 });
}

export function accountHome(
	uid = process.getuid?.() ?? -1,
	platform: NodeJS.Platform = process.platform,
	run: (command: string, args: string[]) => string = runAccountCommand,
): string | undefined {
	if (uid < 0) return undefined;
	if (platform === "linux") {
		try {
			const listed = run("getent", ["passwd", String(uid)]);
			const home = listed.split(":")[5];
			if (home) return home;
		} catch {
			// getent is missing or the uid is only in /etc/passwd.
		}
		try {
			const text = readFileSync("/etc/passwd", "utf8");
			for (const line of text.split("\n")) {
				const parts = line.split(":");
				if (parts.length >= 6 && Number(parts[2]) === uid && parts[5]) return parts[5];
			}
		} catch {
			return undefined;
		}
		return undefined;
	}
	if (platform === "darwin") {
		try {
			const listed = run("id", ["-P"]);
			const home = listed.trim().split(":")[8];
			if (home) return home;
		} catch {
			// id -P is unavailable; try Directory Services.
		}
		try {
			const name = run("id", ["-un"]).trim();
			const listed = run("dscl", [".", "-read", `/Users/${name}`, "NFSHomeDirectory"]);
			const match = /NFSHomeDirectory:\s*(\S+)/.exec(listed);
			if (match?.[1]) return match[1];
		} catch {
			return undefined;
		}
		return undefined;
	}
	return undefined;
}

export function allowSendHome(homeDir?: string): string | undefined {
	const dir = homeDir === undefined ? accountHome() : homeDir;
	if (!dir) return undefined;
	return join(dir, ".dg");
}

export function fixedConfigPath(home: string): string {
	return join(home, "ssms", "config.yaml");
}

export function readFixedAllowSend(home: string | undefined): boolean {
	if (!home) return false;
	const path = fixedConfigPath(home);
	if (!existsSync(path)) return false;
	const value = parseYaml(readFileSync(path, "utf8")) as { allow_send?: unknown } | null;
	return value?.allow_send === true;
}

export function readFixedGoogleSendEnabled(home: string | undefined): boolean {
	if (!home) return false;
	const path = fixedConfigPath(home);
	if (!existsSync(path)) return false;
	const value = parseYaml(readFileSync(path, "utf8")) as {
		google?: { send_enabled?: unknown };
	} | null;
	return value?.google?.send_enabled === true;
}

function loadConfig(path: string | undefined, home: string | undefined): SmsCleanupConfig {
	let overlay: unknown;
	if (path) {
		const text = readFileSync(path, "utf8");
		overlay = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
		if (overlay && typeof overlay === "object" && "allow_send" in overlay) {
			throw new Error("allow_send cannot be set with --config; edit the fixed ssms config");
		}
	}
	const config = parseCleanupConfig(overlay);
	config.allow_send = readFixedAllowSend(home);
	return config;
}

function allowDirectory(runtime: SsmsRuntime): string | undefined {
	if (runtime.passwdHome === null) return undefined;
	if (typeof runtime.passwdHome === "string") return join(runtime.passwdHome, ".dg");
	if (runtime.configHome) return runtime.configHome;
	return allowSendHome();
}

function revealToken(
	draftId: string,
	token: string,
	reveal?: (id: string, value: string) => void,
	openTerminal: (path: string, flags: string) => number = openSync,
): void {
	if (reveal) {
		reveal(draftId, token);
		return;
	}
	let fd: number;
	try {
		fd = openTerminal("/dev/tty", "w");
	} catch {
		throw new Error("approval token not shown: no terminal");
	}
	try {
		writeSync(fd, `approve ${draftId} ${token}\n`);
	} finally {
		closeSync(fd);
	}
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
		const allowHome = allowDirectory(runtime);
		const env = runtime.env ?? process.env;
		const config = loadConfig(args.config, allowHome);
		const session = await openSession(args.provider, runtime, home, env, config, log, args.verb);
		stop = session.stop;
		opened = session.opened;
		await dispatch(args, session.provider, config, runtime, home, allowHome, writeOut, log);
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
	log({ id: "signal-daemon", reason: "daemon-start", provider: "signal", verb });
	return { transport: started.transport, stop: started.stop };
}

async function dispatch(
	args: ParsedArgs,
	provider: SmsProvider,
	config: SmsCleanupConfig,
	runtime: SsmsRuntime,
	home: string,
	allowHome: string | undefined,
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
		const created = await provider.draftReply({
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
		const approvalToken = randomBytes(16).toString("hex");
		const draft = { ...created, approvalTokenHash: hashToken(approvalToken) };
		writeDraft(home, draft);
		try {
			revealToken(draft.id, approvalToken, runtime.revealToken, runtime.openTerminal);
		} catch (error) {
			rmSync(draftPath(home, draft.id), { force: true });
			throw error;
		}
		const body = [
			args.text ? `text: ${args.text}` : "",
			args.emoji ? `emoji: ${args.emoji}` : "",
			args.attachments.length ? `attachments: ${args.attachments.join(", ")}` : "",
			args.quoteTimestamp !== undefined ? `quote: ${args.quoteTimestamp}` : "",
		]
			.filter(Boolean)
			.join("\n");
		const published = { ...draft, approvalTokenHash: undefined };
		emit(
			{ ok: true, draft: published },
			`draft ${draft.id}\nprovider: ${draft.provider}\nconversation: ${draft.conversationId}\n${body}\n`,
		);
		return;
	}
	if (verb === "send") {
		if (!args.draft) throw new UsageError("send needs --draft ID");
		if (args.dryRun || config.dry_run) {
			readDraft(home, args.draft);
			log({ id: args.draft, reason: "dry-run", provider: provider.id, verb: "send" });
			emit(
				{ ok: true, dryRun: true, draftId: args.draft },
				`dry-run send ${args.draft}\n`,
			);
			return;
		}
		const pending = readDraft(home, args.draft);
		const decision = await authorizeSend({
			allowSend: config.allow_send,
			hook: isHookEnv(runtime.env ?? process.env),
			draftId: args.draft,
			tty: runtime.stdinIsTTY === true,
			token: args.approve,
			expectedTokenHash: pending.approvalTokenHash,
			ask: runtime.ask,
		});
		if (!decision.ok) {
			log({ id: args.draft, reason: "send-refused", provider: provider.id, verb: "send" });
			if (decision.message === "send declined") throw new SendDeclined();
			throw new Error(decision.message);
		}
		if (provider.id === "google" && !readFixedGoogleSendEnabled(allowHome)) {
			throw new Error("google send is disabled; set google.send_enabled: true in the ssms config");
		}
		const result = await provider.sendDraft({
			draftId: args.draft,
			confirmed: true,
			hook: false,
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
