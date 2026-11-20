import { isAbsolute } from "node:path";
import { describeError, isRecord, noteSecret } from "@dg/common";
import { sanitize } from "./sanitize";

export type SecretSource = {
	type: "aws-secretsmanager";
	secretId: string;
	region: string;
	key?: string;
	profile?: string;
};

export type RunSourceResult = { code: number; stdout: string; stderr: string };

export type RunSource = (
	argv: string[],
	options: { env: Record<string, string | undefined>; cwd?: string; timeoutMs: number },
) => Promise<RunSourceResult>;

export type SecretFetchDeps = {
	which(name: string, env?: { PATH?: string; cwd?: string }): string | null;
	runSource: RunSource;
	env: Record<string, string | undefined>;
	cwd?: string;
};

export type SecretFetchKind =
	| "not-installed"
	| "failed"
	| "timeout"
	| "no-text"
	| "invalid-json"
	| "no-key";

/** Carries a kind and, for failed and timeout, one sanitized line; it never holds stdout. */
export class SecretFetchError extends Error {
	constructor(
		readonly kind: SecretFetchKind,
		detail = "",
	) {
		super(detail === "" ? kind : detail);
		this.name = "SecretFetchError";
	}
}

export const FETCH_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

const firstLine = (text: string): string =>
	sanitize(text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "");

function readCapped(stream: ReadableStream<Uint8Array>, limit: number, onExceed?: () => void) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	const text = (async () => {
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (total < limit) chunks.push(value.subarray(0, limit - total));
				total += value.length;
				if (total > limit && onExceed) {
					onExceed();
					break;
				}
			}
		} catch {
			return Buffer.concat(chunks).toString("utf8");
		}
		return Buffer.concat(chunks).toString("utf8");
	})();
	return { text, cancel: () => reader.cancel().catch(() => undefined) };
}

/** Runs one program with no shell, no stdin, a time limit and a limit on the stdout it may write. */
export const defaultRunSource: RunSource = async (argv, { env, cwd, timeoutMs }) => {
	const proc = Bun.spawn(argv, {
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		killSignal: "SIGKILL",
		detached: process.platform !== "win32",
	});
	const out = readCapped(proc.stdout, MAX_STDOUT_BYTES, () => stop("overflow"));
	const err = readCapped(proc.stderr, MAX_STDERR_BYTES);
	let reason: "timeout" | "overflow" | undefined;
	function stop(why: "timeout" | "overflow"): void {
		reason ??= why;
		try {
			if (process.platform === "win32") proc.kill("SIGKILL");
			else process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
		void out.cancel();
		void err.cancel();
	}
	const timer = setTimeout(() => stop("timeout"), timeoutMs);
	try {
		const [stdout, stderr] = await Promise.all([out.text, err.text]);
		await proc.exited;
		if (reason === "overflow") throw new SecretFetchError("failed", "output is larger than 128 KiB");
		if (reason === "timeout") {
			throw new SecretFetchError("timeout", `timed out after ${timeoutMs / 1000} s`);
		}
		return { code: proc.exitCode ?? 1, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
};

const argumentFields = ["secretId", "region", "profile"] as const;

function pick(stdout: string, key: string | undefined): string {
	const text = stdout.replace(/\r?\n$/, "");
	if (text === "" || text === "None") throw new SecretFetchError("no-text");
	if (key === undefined) return text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new SecretFetchError("invalid-json");
	}
	const value = isRecord(parsed) && Object.hasOwn(parsed, key) ? parsed[key] : undefined;
	if (typeof value !== "string") throw new SecretFetchError("no-key");
	if (value === "") throw new SecretFetchError("no-text");
	return value;
}

/** Fetches one secret through the runSource seam; it prints nothing and returns the value. */
export async function fetchSecret(source: SecretSource, deps: SecretFetchDeps): Promise<string> {
	for (const field of argumentFields) {
		const given = source[field];
		if (given !== undefined && (given === "" || given.startsWith("-"))) {
			throw new SecretFetchError("failed", `the source "${field}" is not valid`);
		}
	}
	const aws = deps.which("aws", { PATH: deps.env.PATH });
	if (aws === null || !isAbsolute(aws)) throw new SecretFetchError("not-installed");
	const argv = [
		aws,
		"secretsmanager",
		"get-secret-value",
		"--secret-id",
		source.secretId,
		"--region",
		source.region,
		...(source.profile === undefined ? [] : ["--profile", source.profile]),
		"--query",
		"SecretString",
		"--output",
		"text",
	];
	let result: RunSourceResult;
	try {
		result = await deps.runSource(argv, {
			env: deps.env,
			cwd: deps.cwd,
			timeoutMs: FETCH_TIMEOUT_MS,
		});
	} catch (err) {
		if (err instanceof SecretFetchError) throw err;
		throw new SecretFetchError("failed", firstLine(describeError(err)));
	}
	noteSecret(result.stdout);
	if (result.code !== 0) {
		throw new SecretFetchError("failed", firstLine(result.stderr) || `exit ${result.code}`);
	}
	const value = pick(result.stdout, source.key);
	noteSecret(value);
	return value;
}
