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
	resolveDgPaths,
} from "@dg/common/node";
import type { Command } from "commander";

const EXPIRING_WITHIN_MS = 14 * 86_400_000;

export type CredentialsDeps = {
	createClient(
		session?: string,
	): Pick<
		CredentialClient,
		"set" | "list" | "delete" | "grant" | "revoke" | "listGrants" | "close"
	>;
	readValue(): Promise<string>;
	write(line: string): void;
	now(): Date;
};

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

/** Registers list, set, delete, grant and revoke; no subcommand prints a stored value or token. */
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
		.action(async (_options, command: Command) => {
			await withClient(command, async (client) => {
				const now = deps.now();
				output({
					kind: "credentials",
					credentials: (await client.list()).map((entry) =>
						listEntry(entry, now),
					),
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
}
