import { remove, resolve } from "./registry";
import { call, type DaemonRequest } from "./socket";
import type { ClientEnv, ParsedArgs } from "./spec";

export const VERSION = "0.1.0";

const NOT_OPEN_HINT = "Run: pw open";

export function defaultEnv(): ClientEnv {
	const line = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
	return {
		cwd: process.cwd(),
		out: (text) => void (text === "" || process.stdout.write(line(text))),
		err: (text) => void process.stderr.write(line(text)),
	};
}

function envSnapshotDepth(): number | undefined {
	const value = process.env["PW_SNAPSHOT_DEPTH"];
	return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

function isConnectionFailure(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ECONNREFUSED";
}

export async function forward(
	parsed: ParsedArgs,
	method: Extract<DaemonRequest, { params: unknown }>["method"],
	argv: string[],
	env: ClientEnv,
): Promise<number> {
	const record = resolve(parsed.session);
	if (!record) {
		env.err(`Browser '${parsed.session}' is not open. ${NOT_OPEN_HINT}`);
		return 1;
	}
	let response: Awaited<ReturnType<typeof call>>;
	try {
		response = await call(record, {
			id: String(process.pid),
			method,
			params: { argv, cwd: env.cwd, raw: parsed.raw, snapshotDepth: envSnapshotDepth() },
		});
	} catch (error) {
		if (!isConnectionFailure(error)) throw error;
		remove(record.key);
		env.err(`Browser '${parsed.session}' is not open. ${NOT_OPEN_HINT}`);
		return 1;
	}
	if ("error" in response) {
		env.err(response.error);
		return 1;
	}
	(response.result.exitCode === 0 ? env.out : env.err)(response.result.text);
	return response.result.exitCode;
}
