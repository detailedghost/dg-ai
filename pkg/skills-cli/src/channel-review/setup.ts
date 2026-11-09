import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import {
	type ChannelConfig,
	channelReviewPaths,
	ENV_NAMES,
	type EnvName,
	type EnvSettings,
	validateConfig,
} from "@dg/channel-review";
import { DgCliError, describeError } from "@dg/common";
import { ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import example from "../../../../plugins/dg/skills/channel-review/references/config.example.json" with {
	type: "json",
};

export type SetupFlags = { force?: boolean };

export type SetupDeps = {
	configPath: string;
	isTTY: boolean;
	ask(question: string): Promise<string>;
	close(): void;
	write(line: string): void;
	gitEmail(): string | undefined;
	region(): string | undefined;
	connectRelay(env: EnvName): Promise<void>;
};

const CHAT_ID = /^19:.+@thread\.(v2|tacv2)$/;

const REQUIRED_KEYS = [
	"chats",
	"envs.<env>.baseUrl, awsProfile, botName",
	"owner.token, owner.email",
	"relay.appName, relay.secret.id, key, region",
];

/** One readline for every question; its line iterator buffers lines typed or pasted ahead. */
export function linePrompt(): { ask(question: string): Promise<string>; close(): void } {
	let rl: Interface | undefined;
	let lines: AsyncIterator<string> | undefined;
	return {
		ask: async (question) => {
			rl ??= createInterface({ input: process.stdin, terminal: false });
			lines ??= rl[Symbol.asyncIterator]();
			process.stderr.write(question);
			const next = await lines.next();
			if (next.done) throw new DgCliError("setup canceled: input ended");
			return next.value;
		},
		close: () => rl?.close(),
	};
}

function readGitEmail(): string | undefined {
	const result = Bun.spawnSync(["git", "config", "user.email"], { stdout: "pipe", stderr: "ignore" });
	const email = result.stdout.toString().trim();
	return result.exitCode === 0 && email !== "" ? email : undefined;
}

export const defaultSetupDeps = (): SetupDeps => ({
	configPath: channelReviewPaths("dev").configPath,
	isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
	...linePrompt(),
	write: (line) => process.stderr.write(`${line}\n`),
	gitEmail: readGitEmail,
	region: () => process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
	connectRelay: async (env) => {
		const { runConnect } = await import("./connect");
		await runConnect("relay", { env });
	},
});

async function field(deps: SetupDeps, label: string, fallback?: string): Promise<string> {
	const hint = fallback === undefined ? "" : ` [${fallback}]`;
	for (;;) {
		const answer = (await deps.ask(`${label}${hint}: `)).trim();
		if (answer !== "") return answer;
		if (fallback !== undefined) return fallback;
		deps.write(`${label} is required.`);
	}
}

async function yes(deps: SetupDeps, question: string, fallback: boolean): Promise<boolean> {
	const answer = (await deps.ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}: `)).trim().toLowerCase();
	return answer === "" ? fallback : answer.startsWith("y");
}

async function pickEnv(deps: SetupDeps): Promise<EnvName> {
	for (;;) {
		const answer = await field(deps, `Default env (${ENV_NAMES.join("/")})`, "dev");
		const env = ENV_NAMES.find((name) => name === answer);
		if (env) return env;
		deps.write(`Default env must be one of: ${ENV_NAMES.join(", ")}.`);
	}
}

async function envSettings(deps: SetupDeps, env: EnvName): Promise<EnvSettings> {
	return {
		baseUrl: await field(deps, `${env} relay base URL`),
		awsProfile: await field(deps, `${env} AWS profile`),
		botName: await field(deps, `${env} bot display name`),
	};
}

/** Asks for each required channel-review setting and returns the config object. */
export async function askConfig(deps: SetupDeps): Promise<Record<string, unknown>> {
	const chat = await field(deps, "Teams chat topic, or chat id (19:...@thread.v2)");
	const defaultEnv = await pickEnv(deps);
	const envs: Partial<Record<EnvName, EnvSettings>> = { [defaultEnv]: await envSettings(deps, defaultEnv) };
	for (const other of ENV_NAMES.filter((name) => name !== defaultEnv)) {
		if (await yes(deps, `Set up ${other} too?`, false)) envs[other] = await envSettings(deps, other);
	}
	return {
		env: { default: defaultEnv },
		envs,
		chats: [CHAT_ID.test(chat) ? { id: chat } : { topic: chat }],
		owner: {
			token: await field(deps, "Owner gate token", "!owner"),
			email: await field(deps, "Owner email", deps.gitEmail()),
		},
		relay: {
			appName: await field(deps, "Relay app name"),
			secret: {
				id: await field(deps, "Relay secret id in AWS Secrets Manager"),
				key: await field(deps, "JSON key inside that secret"),
				region: await field(deps, "Secret region", deps.region() ?? "us-east-1"),
			},
		},
	};
}

function writeTemplate(deps: SetupDeps): void {
	const template = join(dirname(deps.configPath), "config.example.json");
	ensurePrivateDir(dirname(template));
	writeFileAtomic(template, `${JSON.stringify(example, null, "\t")}\n`, 0o600);
	deps.write(`No terminal to ask in. Wrote a template to ${template}.`);
	deps.write(`Fill in ${REQUIRED_KEYS.join("; ")}, then rename it to ${deps.configPath}.`);
	deps.write("Or run dg-skills channel-review setup in a terminal.");
}

/** Creates the channel-review config: asks on a terminal, writes a template otherwise. */
export async function runSetup(flags: SetupFlags, deps: SetupDeps = defaultSetupDeps()): Promise<number> {
	if (existsSync(deps.configPath) && !flags.force)
		throw new DgCliError(`${deps.configPath} already exists; pass --force to replace it`);
	if (!deps.isTTY) {
		writeTemplate(deps);
		return 1;
	}
	deps.write(`Creating ${deps.configPath}. Press Enter to keep a [default].`);
	let config: ChannelConfig;
	let relayNow: boolean;
	try {
		const raw = await askConfig(deps);
		config = validateConfig(raw, deps.configPath);
		ensurePrivateDir(dirname(deps.configPath));
		writeFileAtomic(deps.configPath, `${JSON.stringify(raw, null, "\t")}\n`, 0o600);
		deps.write(`Saved ${deps.configPath}.`);
		relayNow = await yes(deps, "Store the relay secret in the dg credential store now?", true);
	} finally {
		deps.close();
	}
	if (relayNow) {
		try {
			await deps.connectRelay(config.env.default);
		} catch (error) {
			deps.write(`Relay secret not stored: ${describeError(error)}`);
			deps.write("Run dg-skills channel-review connect relay after aws sso login.");
		}
	}
	deps.write("Next: dg-skills channel-review start");
	return 0;
}
