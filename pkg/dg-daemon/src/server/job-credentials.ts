import {
	credentialNameInPrefix,
	isRecord,
	isReservedCredentialPrefix,
	noteSecret,
	validateCredentialMeta,
	validateCredentialName,
	validateCredentialValue,
} from "@dg/common";
import { assertNotBlocked } from "@dg/common/node/layout";
import {
	credentialGrantTokenPath,
	ensurePrivateDir,
	type DgPaths,
	readCredentialGrantToken,
	writeCredentialGrantToken,
} from "@dg/common/node";
import type { ParsedJob } from "../jobs/config";
import type { CredentialStore } from "../store/credentials-store";
import {
	isJsonContentType,
	json,
	readJsonObject,
	refuse,
	STORAGE_FAILED,
} from "./capped-body";
import { NOT_ALLOWED } from "./credentials";
import type { Logger } from "./log";

export type JobCredentialStore = Pick<
	CredentialStore,
	| "listCredentials"
	| "setCredential"
	| "deleteCredential"
	| "createCredentialGrant"
	| "inspectCredentialGrant"
>;

export type JobCredentialsDeps = {
	paths: DgPaths;
	store: JobCredentialStore;
	readJobs: () => ParsedJob[];
	isOwner: (req: Request) => boolean;
	logger: Pick<Logger, "error">;
};

const MAX_BODY_BYTES = 128 * 1024;
const BODY_KEYS = {
	status: ["operation"],
	set: ["operation", "name", "value", "meta"],
	delete: ["operation", "name"],
	"ensure-grant": ["operation"],
	"rotate-grant": ["operation"],
} as const;
type Operation = keyof typeof BODY_KEYS;

const isOperation = (value: unknown): value is Operation =>
	typeof value === "string" && Object.hasOwn(BODY_KEYS, value);

function readGrantToken(paths: DgPaths, prefix: string): string | undefined {
	try {
		const token = readCredentialGrantToken(paths, prefix);
		noteSecret(token);
		return token || undefined;
	} catch {
		return undefined;
	}
}

function grantState(
	paths: DgPaths,
	store: JobCredentialStore,
	prefix: string,
): { state: "ok" | "missing" | "stale"; valid: boolean } {
	const token = readGrantToken(paths, prefix);
	const { row, valid } = store.inspectCredentialGrant(prefix, token);
	if (valid) return { state: "ok", valid };
	return { state: !row && token === undefined ? "missing" : "stale", valid };
}

function writeNewGrant(
	paths: DgPaths,
	store: JobCredentialStore,
	prefix: string,
): string {
	assertNotBlocked(paths, "grants");
	ensurePrivateDir(paths.grantsDir);
	const token = store.createCredentialGrant(prefix);
	noteSecret(token);
	return writeCredentialGrantToken(paths, prefix, token);
}

function validated<T>(check: () => T): T | Response {
	try {
		return check();
	} catch (err) {
		return refuse(err instanceof Error ? err.message : "invalid request", 400);
	}
}

function run(
	operation: Operation,
	body: Record<string, unknown>,
	prefix: string,
	deps: JobCredentialsDeps,
): Response {
	const { paths, store } = deps;
	switch (operation) {
		case "status":
			return json(
				{
					prefix,
					grant: grantState(paths, store, prefix).state,
					credentials: store
						.listCredentials()
						.filter((entry) => credentialNameInPrefix(entry.name, prefix)),
				},
				200,
			);
		case "set": {
			const input = validated(() => ({
				name: validateCredentialName(body.name),
				value: validateCredentialValue(body.value),
				meta: body.meta === undefined ? {} : validateCredentialMeta(body.meta),
			}));
			if (input instanceof Response) return input;
			store.setCredential(input.name, input.value, input.meta);
			return json({ ok: true }, 200);
		}
		case "delete": {
			const name = validated(() => validateCredentialName(body.name));
			if (name instanceof Response) return name;
			return json({ deleted: store.deleteCredential(name) }, 200);
		}
		case "ensure-grant": {
			if (grantState(paths, store, prefix).valid)
				return json(
					{ created: false, path: credentialGrantTokenPath(paths, prefix) },
					200,
				);
			return json({ created: true, path: writeNewGrant(paths, store, prefix) }, 200);
		}
		case "rotate-grant":
			return json({ path: writeNewGrant(paths, store, prefix) }, 200);
	}
}

/** Writes credentials and makes the grant for the prefix of one job; no operation returns a value. */
export async function handleJobCredentials(
	req: Request,
	jobName: string,
	deps: JobCredentialsDeps,
): Promise<Response> {
	if (req.headers.get("origin") !== null)
		return refuse("refused: the job credential route rejects an Origin header", 400);
	if (!deps.isOwner(req)) return refuse("refused", 401);
	if (req.method !== "POST") return refuse("not found", 404);
	let jobs: ParsedJob[];
	try {
		jobs = deps.readJobs();
	} catch (err) {
		deps.logger.error(
			`job credential request could not read the jobs table: ${err instanceof Error ? err.name : typeof err}`,
		);
		return refuse("could not read the jobs table; check the dg config", 500);
	}
	try {
		const job = jobs.find((entry) => entry.name === jobName);
		if (!job) return refuse(`no job named "${jobName}"`, 404);
		if (!job.ok) return refuse(`job "${jobName}" is not valid: ${job.error}`, 409);
		const prefix = job.grant;
		if (prefix === undefined)
			return refuse(`job "${jobName}" has no credential prefix`, 409);
		if (isReservedCredentialPrefix(prefix))
			return refuse(NOT_ALLOWED, 403);
		if (!isJsonContentType(req))
			return refuse("Content-Type must be application/json", 415);
		const body = await readJsonObject(req, MAX_BODY_BYTES);
		if (body === "too-large") return refuse("request body is too large", 413);
		if (!body) return refuse("request body must be a JSON object", 400);
		if (typeof body.value === "string") noteSecret(body.value);
		if (body.operation === "get") return refuse(NOT_ALLOWED, 403);
		if (!isOperation(body.operation))
			return refuse('"operation" must be one of ' + Object.keys(BODY_KEYS).join(", "), 400);
		const allowed: readonly string[] = BODY_KEYS[body.operation];
		if (Object.keys(body).some((key) => !allowed.includes(key)))
			return refuse("request body has a key that this operation does not take", 400);
		if (allowed.includes("name")) {
			if (typeof body.name !== "string") return refuse('"name" must be a string', 400);
			if (!credentialNameInPrefix(body.name, prefix))
				return refuse(NOT_ALLOWED, 403);
		}
		return run(body.operation, body, prefix, deps);
	} catch (err) {
		deps.logger.error(
			`job credential request failed: ${err instanceof Error ? err.name : typeof err}`,
		);
		return refuse(STORAGE_FAILED, 500);
	}
}
