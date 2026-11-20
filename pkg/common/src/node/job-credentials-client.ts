import { jobCredentialsPath } from "../chat-format";
import { OWNER_TOKEN_HEADER } from "../cli-wire";
import type { CredentialMeta, CredentialSummary } from "../credentials-format";
import { DgCliError, EXIT_GENERAL_FAILURE } from "../errors";
import { noteSecret } from "../redact";
import { DaemonNotRunningError } from "./credentials-client";
import { requireOwnerToken } from "./owner-token";
import type { DgPaths } from "./dg-paths";
import { loopbackHostHeader, readPidFile } from "./pidfile";

const REQUEST_TIMEOUT_MS = 10_000;
export const OLDER_DAEMON_TEXT =
	"this dg-daemon is older than the CLI — run dg daemon restart";

export type JobCredentialStatus = {
	prefix: string;
	grant: "ok" | "missing" | "stale";
	credentials: CredentialSummary[];
};

export type JobCredentialClient = {
	status(): Promise<JobCredentialStatus>;
	set(name: string, value: string, meta?: CredentialMeta): Promise<void>;
	delete(name: string): Promise<boolean>;
	ensureGrant(): Promise<{ created: boolean; path: string }>;
	rotateGrant(): Promise<{ path: string }>;
};

function refusalText(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const { ok, error } = body as { ok?: unknown; error?: unknown };
	return ok === false && typeof error === "string" ? error : undefined;
}

async function parseBody(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

/** Writes credentials and makes the grant of one job through the owner-token route of dg-daemon. */
export function createJobCredentialClient(options: {
	paths: DgPaths;
	job: string;
}): JobCredentialClient {
	const { paths, job } = options;
	const request = async (body: Record<string, unknown>): Promise<unknown> => {
		const handle = readPidFile(paths);
		if (!handle) throw new DaemonNotRunningError();
		const owner = requireOwnerToken(paths);
		let response: Response;
		try {
			response = await fetch(
				`http://127.0.0.1:${handle.port}${jobCredentialsPath(job)}`,
				{
					method: "POST",
					headers: {
						...loopbackHostHeader(handle.port),
						"Content-Type": "application/json",
						[OWNER_TOKEN_HEADER]: owner,
					},
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				},
			);
		} catch (err) {
			if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
				throw new DgCliError(
					`dg-daemon did not answer within ${REQUEST_TIMEOUT_MS / 1000} s for the credentials of job "${job}"; the change may have been stored`,
					EXIT_GENERAL_FAILURE,
				);
			}
			throw new DaemonNotRunningError();
		}
		const answer = await parseBody(response);
		if (response.ok) return answer ?? {};
		const error = refusalText(answer);
		if (response.status === 404 && error === undefined)
			throw new DgCliError(OLDER_DAEMON_TEXT, EXIT_GENERAL_FAILURE);
		throw new DgCliError(
			error ?? `dg-daemon answered ${response.status} for the credentials of job "${job}"`,
			EXIT_GENERAL_FAILURE,
		);
	};
	return {
		status: async () => (await request({ operation: "status" })) as JobCredentialStatus,
		set: async (name, value, meta) => {
			noteSecret(value);
			await request({
				operation: "set",
				name,
				value,
				...(meta === undefined ? {} : { meta }),
			});
		},
		delete: async (name) =>
			((await request({ operation: "delete", name })) as { deleted: boolean }).deleted,
		ensureGrant: async () =>
			(await request({ operation: "ensure-grant" })) as {
				created: boolean;
				path: string;
			},
		rotateGrant: async () =>
			(await request({ operation: "rotate-grant" })) as { path: string },
	};
}
