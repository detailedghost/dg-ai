import {
	type CredentialMeta,
	type CredentialSummary,
	validateCredentialGrantPrefix,
	validateCredentialMeta,
	validateCredentialName,
} from "@dg/common";
import {
	type CredentialClient,
	createCredentialClient,
	execAllowlistLine,
	resolveDgPaths,
} from "@dg/common/node";
import type { Command } from "commander";
import { runSubtree } from "../utils/lazy-command";

const EXPIRING_WITHIN_MS = 14 * 86_400_000;

export type CredentialsDeps = {
	createClient(
		session?: string,
	): Pick<
		CredentialClient,
		"set" | "exec" | "list" | "delete" | "grant" | "revoke" | "listGrants" | "close"
	>;
	readValue(): Promise<string>;
	write(line: string): void;
	now(): Date;
	stdout?(text: string): void;
	stderr?(text: string): void;
	exit?(code: number): void;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function derivedEnvName(name: string): string {
	const env = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	return /^[0-9]/.test(env) ? `_${env}` : env;
}

type Binding = { name: string; env: string };

function parseBindings(specs: string[]): Binding[] {
	const bindings = specs.map((spec, index) => {
		const equal = spec.indexOf("=");
		const rawName = equal === -1 ? spec : spec.slice(0, equal);
		const name = validateCredentialName(rawName);
		const env = equal === -1 ? derivedEnvName(name) : spec.slice(equal + 1);
		if (!ENV_NAME.test(env))
			throw new Error(
				`Credential spec ${index + 1} has an invalid env var name; use ${ENV_NAME.source}.`,
			);
		return { name, env };
	});
	const seen = new Set<string>();
	for (const { env } of bindings) {
		if (seen.has(env))
			throw new Error(`Env var ${env} is bound by more than one credential.`);
		seen.add(env);
	}
	return bindings;
}

export type HiddenInput = {
	setRawMode(mode: boolean): unknown;
	setEncoding(encoding: "utf8"): unknown;
	resume(): unknown;
	pause(): unknown;
	on(event: "data", listener: (chunk: string) => void): unknown;
	off(event: "data", listener: (chunk: string) => void): unknown;
};

/** Reads one line from a raw-mode TTY without echoing it. */
export function promptHidden(
	prompt: string,
	stdin: HiddenInput = process.stdin,
	output: { write(text: string): unknown } = process.stderr,
): Promise<string> {
	output.write(prompt);
	stdin.setRawMode(true);
	stdin.setEncoding("utf8");
	stdin.resume();
	return new Promise((resolve, reject) => {
		let value = "";
		const finish = (error?: Error) => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			output.write("\n");
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n") return finish();
				if (char === "\u0003") return finish(new Error("Canceled."));
				if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
				else value += char;
			}
		};
		stdin.on("data", onData);
	});
}

/** Reads the secret from piped stdin, or from a hidden prompt on a TTY; it is never echoed. */
export async function readCredentialValue(): Promise<string> {
	if (process.stdin.isTTY) return promptHidden("Credential value: ");
	return (await Bun.stdin.text()).replace(/\r?\n$/, "");
}

const defaultDeps: CredentialsDeps = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	exit: (code) => {
		process.exitCode = code;
	},
	createClient: (session) =>
		createCredentialClient({ paths: resolveDgPaths(), session }),
	readValue: readCredentialValue,
	write: (line) => console.log(line),
	now: () => new Date(),
};

function parseMeta(pairs: string[]): CredentialMeta {
	const meta: CredentialMeta = {};
	for (const pair of pairs) {
		const equal = pair.indexOf("=");
		if (equal < 1) throw new Error("Use --meta KEY=VALUE.");
		const key = pair.slice(0, equal);
		const value = pair.slice(equal + 1);
		if (key in meta)
			throw new Error(`--meta ${key} may only be supplied once.`);
		meta[key] =
			key === "scopes" ? value.split(/[,\s]+/).filter(Boolean) : value;
	}
	return validateCredentialMeta(meta);
}

function expiry(
	expiresAt: unknown,
	now: Date,
): "expired" | "expiring" | undefined {
	if (typeof expiresAt !== "string") return undefined;
	const remaining = Date.parse(expiresAt) - now.getTime();
	if (remaining <= 0) return "expired";
	return remaining < EXPIRING_WITHIN_MS ? "expiring" : undefined;
}

function listEntry(credential: CredentialSummary, now: Date) {
	const { provider, site, expiresAt } = credential.meta;
	return {
		name: credential.name,
		provider,
		site,
		expiresAt,
		updatedAt: credential.updatedAt,
		expiry: expiry(expiresAt, now),
	};
}

/** Registers list, set, delete, grant, revoke and exec; no subcommand prints a stored value or token, and exec runs in the daemon. */
export function registerCredentials(
	program: Command,
	deps: CredentialsDeps = defaultDeps,
): void {
	const credentials = program
		.command("credentials")
		.description(
			"Manage secrets in dg-daemon's encrypted credential store; values are never printed.",
		)
		.option("--session <id>", "dg session to authenticate with");
	const withClient = async (
		command: Command,
		run: (client: ReturnType<CredentialsDeps["createClient"]>) => Promise<void>,
	) => {
		const client = deps.createClient(
			command.optsWithGlobals<{ session?: string }>().session,
		);
		try {
			await run(client);
		} finally {
			client.close();
		}
	};
	const output = (value: unknown) => deps.write(JSON.stringify(value));

	credentials
		.command("list")
		.description(
			"List names and metadata; flags entries expiring within 14 days",
		)
		.option(
			"--meta",
			"print every stored metadata field instead of the summary projection; still never prints a value",
		)
		.action(async (options: { meta?: boolean }, command: Command) => {
			await withClient(command, async (client) => {
				const now = deps.now();
				const stored = await client.list();
				output({
					kind: "credentials",
					credentials: options.meta
						? stored.map((entry) => ({
								name: entry.name,
								meta: entry.meta,
								updatedAt: entry.updatedAt,
							}))
						: stored.map((entry) => listEntry(entry, now)),
					grants: await client.listGrants(),
				});
			});
		});

	credentials
		.command("set")
		.description("Store a value read from stdin, or a hidden prompt on a TTY")
		.argument("<name>", "credential name, for example consumer/provider")
		.option(
			"--meta <key=value>",
			"non-secret metadata such as provider, site, scopes, expiresAt, createdBy or note",
			(pair: string, pairs: string[]) => [...pairs, pair],
			[] as string[],
		)
		.action(
			async (
				rawName: string,
				options: { meta: string[] },
				command: Command,
			) => {
				const name = validateCredentialName(rawName);
				const meta = parseMeta(options.meta);
				const value = await deps.readValue();
				await withClient(command, async (client) => {
					await client.set(name, value, meta);
					output({ kind: "credential-saved", name, meta });
				});
			},
		);

	credentials
		.command("delete")
		.description("Remove a stored credential")
		.argument("<name>", "credential name")
		.action(async (rawName: string, _options, command: Command) => {
			const name = validateCredentialName(rawName);
			await withClient(command, async (client) => {
				output({
					kind: "credential-deleted",
					name,
					deleted: await client.delete(name),
				});
			});
		});

	credentials
		.command("grant")
		.description(
			"Create or rotate a read-only service token for names under <prefix>/",
		)
		.argument("<prefix>", "consumer prefix, for example channel-review")
		.action(async (rawPrefix: string, _options, command: Command) => {
			const prefix = validateCredentialGrantPrefix(rawPrefix);
			await withClient(command, async (client) => {
				output({ kind: "credential-grant", ...(await client.grant(prefix)) });
			});
		});

	credentials
		.command("revoke")
		.description("Delete a service grant and its token file")
		.argument("<prefix>", "consumer prefix")
		.action(async (rawPrefix: string, _options, command: Command) => {
			const prefix = validateCredentialGrantPrefix(rawPrefix);
			await withClient(command, async (client) => {
				output({
					kind: "credential-grant-revoked",
					prefix,
					revoked: await client.revoke(prefix),
				});
			});
		});

	credentials
		.command("allow")
		.description(
			"Print a pinned exec-allowlist line for a command; it never writes the allowlist file",
		)
		.argument("<path>", "the command to allow, best a small fixed wrapper script the agent cannot write")
		.argument("[glob]", "the pw/ names it may get, for example pw/live.com/*")
		.option("--any-args", "add allow-any-args for a shell, interpreter or general tool; this undoes the guard")
		.action((path: string, glob: string | undefined, options: { anyArgs?: boolean }) => {
			deps.write(execAllowlistLine(path, glob, options.anyArgs === true));
		});

	credentials
		.command("exec")
		.description(
			"Have dg-daemon run a command with credentials in env vars; the CLI never holds a value, output is scrubbed, and pw/ values need the command in the dg exec-allowlist file",
		)
		.usage("<name>[=ENV_VAR]... -- <command...>")
		.argument("[args...]", "credential names, then -- and the command")
		.allowUnknownOption()
		.action(async (_args: string[], _options, command: Command) => {
			let root = command;
			while (root.parent) root = root.parent;
			const { rawArgs } = root as Command & { rawArgs: string[] };
			const raw = rawArgs.slice(rawArgs.indexOf("exec") + 1);
			const split = raw.indexOf("--");
			if (split === -1) throw new Error("Put -- between the credential names and the command.");
			if (raw.slice(0, split).some((arg) => arg.startsWith("--session")))
				throw new Error("Put --session before exec, for example: dg-skills credentials --session <id> exec <name> -- <command>.");
			const bindings = parseBindings(raw.slice(0, split));
			const argv = raw.slice(split + 1);
			if (argv.length === 0) throw new Error("Give a command to run after --.");
			if (bindings.length === 0) throw new Error("Name at least one credential before --.");
			const out = deps.stdout ?? process.stdout.write.bind(process.stdout);
			const err = deps.stderr ?? process.stderr.write.bind(process.stderr);
			const env = Object.fromEntries(
				Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && ENV_NAME.test(entry[0])),
			);
			await withClient(command, async (client) => {
				const code = await client.exec({ bindings, argv, cwd: process.cwd(), env }, (stream, data) =>
					(stream === "stdout" ? out : err)(data),
				);
				(deps.exit ?? ((c) => { process.exitCode = c; }))(code);
			});
		});
}

export function main(argv: string[]): Promise<void> {
	return runSubtree("credentials", (program) => registerCredentials(program), argv);
}
