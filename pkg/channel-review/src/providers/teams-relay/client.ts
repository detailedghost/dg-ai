export class RelayAuthError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(
			`The relay rejected the API code (HTTP ${status}). Check the secret and the environment.`,
		);
		this.name = "RelayAuthError";
		this.status = status;
	}
}

export type RelayClient = {
	request(path: string, init?: RequestInit): Promise<Response>;
};

export function createRelayClient({
	baseUrl,
	appName,
	secret,
	fetch,
}: {
	baseUrl: string;
	appName: string;
	secret: string;
	fetch: typeof globalThis.fetch;
}): RelayClient {
	const apiCode = Buffer.from(`${appName}:${secret}`).toString("base64");
	return {
		async request(path, init = {}) {
			const headers = new Headers(init.headers);
			headers.set("X-Api-Code", apiCode);
			const response = await fetch(`${baseUrl}${path}`, {
				...init,
				headers,
				redirect: "error",
			});
			if (response.status === 401 || response.status === 403) {
				await discard(response);
				throw new RelayAuthError(response.status);
			}
			return response;
		},
	};
}

export async function discard(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 60_000;

export function retryAfterMs(response: Response): number | undefined {
	const raw = response.headers.get("retry-after");
	if (raw === null) return undefined;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds < 0) return undefined;
	return Math.min(Math.max(seconds * 1000, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

export function statusError(label: string, status: number): Error {
	return new Error(`${label} failed with HTTP ${status}`);
}
