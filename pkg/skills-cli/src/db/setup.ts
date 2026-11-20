import { parseArgs } from "node:util";
import { type CredentialMeta, shellValue, validateCredentialName } from "@dg/common";
import type { DbCredentialClient } from "./credentials";
import { createSetupForm, SecretFormExpiredError } from "./setup-form";

export interface SetupPlan {
	name: string;
	meta: CredentialMeta;
	session: string;
}

export interface SetupDeps {
	createCredentialClient(session?: string): DbCredentialClient;
	ensureSession(explicit?: string): Promise<string>;
	runTest(args: string[]): Promise<number | void>;
	stdout(line: string): void;
	form?(plan: SetupPlan): Promise<void>;
}

const OPTIONS = {
	engine: { type: "string" },
	host: { type: "string" },
	port: { type: "string" },
	database: { type: "string" },
	schema: { type: "string" },
	user: { type: "string" },
	account: { type: "string" },
	warehouse: { type: "string" },
	role: { type: "string" },
	auth: { type: "string" },
	"private-key-path": { type: "string" },
	"read-only": { type: "boolean" },
	"no-read-only": { type: "boolean" },
	secret: { type: "string" },
	"secret-id": { type: "string" },
	"secret-key": { type: "string" },
	"aws-profile": { type: "string" },
	"aws-region": { type: "string" },
	session: { type: "string" },
} as const;

const SECRET_MODES = ["aws", "form", "command"] as const;
type SecretMode = (typeof SECRET_MODES)[number];

const EXTERNAL_BROWSER_PLACEHOLDER = "external_browser";
const AWS_PLACEHOLDER = "aws-sm";

interface SetupRequest {
	name: string;
	meta: CredentialMeta;
	session?: string;
	secret?: SecretMode;
	external: boolean;
}

function put(meta: CredentialMeta, key: string, value: string | undefined): void {
	if (value) meta[key] = value;
}

function parseSetup(args: string[]): SetupRequest {
	const { values, positionals } = parseArgs({
		args,
		options: OPTIONS,
		allowPositionals: true,
		strict: true,
	});
	const name = positionals[0];
	if (!name) throw new Error("connection name required");
	validateCredentialName(`db/${name}`);
	if (values["read-only"] && values["no-read-only"])
		throw new Error("--read-only and --no-read-only conflict");

	const engine = values.engine;
	if (engine !== "postgresql" && engine !== "snowflake")
		throw new Error("--engine must be postgresql or snowflake");
	const missing = (flags: string[]) => {
		const absent = flags.filter((flag) => !values[flag as keyof typeof values]);
		if (absent.length > 0)
			throw new Error(`${engine} setup requires ${absent.map((f) => `--${f}`).join(", ")}`);
	};
	if (
		values.port !== undefined &&
		!(/^[1-9][0-9]{0,4}$/.test(values.port) && Number(values.port) <= 65_535)
	)
		throw new Error("--port must be an integer from 1 to 65535");

	const meta: CredentialMeta = { engine };
	put(meta, "host", values.host);
	put(meta, "port", values.port);
	put(meta, "database", values.database);
	put(meta, "schema", values.schema);
	put(meta, "user", values.user);

	let external = false;
	if (engine === "postgresql") {
		missing(["database", "user"]);
		if (values.auth && values.auth !== "password")
			throw new Error("postgresql supports only --auth password");
	} else {
		missing(["account", "user"]);
		const auth = values.auth ?? "password";
		if (auth !== "password" && auth !== "keypair" && auth !== "external_browser")
			throw new Error("--auth must be password, keypair or external_browser");
		put(meta, "account", values.account);
		put(meta, "warehouse", values.warehouse);
		put(meta, "role", values.role);
		if (auth === "keypair") {
			missing(["private-key-path"]);
			meta.authenticator = "snowflake_jwt";
			put(meta, "privateKeyPath", values["private-key-path"]);
		} else if (values["private-key-path"]) {
			throw new Error("--private-key-path requires --auth keypair");
		}
		if (auth === "external_browser") {
			meta.authenticator = "external_browser";
			external = true;
		}
	}
	meta.readOnly = values["no-read-only"] ? "false" : "true";

	const secret = values.secret;
	if (secret !== undefined && !SECRET_MODES.includes(secret as SecretMode))
		throw new Error("--secret must be aws, form or command");
	if (external && secret !== undefined)
		throw new Error("external_browser needs no --secret");
	if (!external && secret === undefined)
		throw new Error("--secret aws|form|command required");
	if (secret !== "aws" && (values["aws-profile"] || values["aws-region"]))
		throw new Error("--aws-profile and --aws-region require --secret aws");
	if (secret === "aws") {
		const absent = ["secret-id", "secret-key"].filter(
			(flag) => !values[flag as keyof typeof values],
		);
		if (absent.length > 0)
			throw new Error(`--secret aws requires ${absent.map((f) => `--${f}`).join(", ")}`);
		meta.secretSource = "aws-sm";
		put(meta, "secretId", values["secret-id"]);
		put(meta, "secretKey", values["secret-key"]);
		put(meta, "awsProfile", values["aws-profile"]);
		put(meta, "awsRegion", values["aws-region"]);
	}
	return {
		name,
		meta,
		session: values.session,
		secret: secret as SecretMode | undefined,
		external,
	};
}

function credentialsSetLine(plan: SetupPlan): string {
	const pairs = Object.entries(plan.meta)
		.map(([key, value]) => `--meta ${shellValue(`${key}=${String(value)}`)}`)
		.join(" ");
	return `dg-skills credentials --session ${shellValue(plan.session)} set db/${plan.name} ${pairs}`;
}

export async function runSetup(args: string[], deps: SetupDeps): Promise<number> {
	const request = parseSetup(args);
	const { name, meta } = request;

	const session = await deps.ensureSession(request.session);
	const plan: SetupPlan = { name, meta, session };

	if (request.secret === "command") {
		deps.stdout(credentialsSetLine(plan));
		deps.stdout(`Next: dg-skills db test ${name}`);
		return 0;
	}
	if (request.secret === "form") {
		const form = deps.form ?? createSetupForm(deps.stdout);
		try {
			await form(plan);
		} catch (error) {
			if (!(error instanceof SecretFormExpiredError)) throw error;
			deps.stdout(error.message);
			deps.stdout(`Next: dg-skills db setup ${args.map(shellValue).join(" ")}`);
			return 1;
		}
	} else {
		const client = deps.createCredentialClient(session);
		try {
			await client.set(
				`db/${name}`,
				request.external ? EXTERNAL_BROWSER_PLACEHOLDER : AWS_PLACEHOLDER,
				meta,
			);
		} finally {
			client.close();
		}
	}

	deps.stdout(
		`Stored db/${name}: ${Object.entries(meta).map(([key, value]) => `${key}=${String(value)}`).join(" ")}`,
	);
	const code = await deps.runTest([name, "--session", session]);
	if (code) {
		deps.stdout(`Next: fix the error above, then run dg-skills db test ${name}`);
		return 1;
	}
	deps.stdout(`Next: dg-skills db tables ${name}`);
	return 0;
}
