import { DgCliError } from "../../errors";
import type { ResolvedCredential } from "../../node/credentials-client";
import { FRAME_MAX_PAYLOAD_BYTES, pluginTokenCredential, ROUTE_TIMEOUT_MS, type Route, validateMessage } from "../contract";
import { checkHttpEndpoint, type PluginManifest } from "../manifest";

export type PluginTransportErrorCode = "timeout" | "auth" | "refused" | "oversize" | "unreachable" | "plugin";

export class PluginTransportError extends DgCliError {
	readonly code: PluginTransportErrorCode;

	constructor(code: PluginTransportErrorCode, message: string) {
		super(`dg plugin: ${message}`);
		this.name = "PluginTransportError";
		this.code = code;
	}
}

export type PluginRequest = { route: Route; body: Record<string, unknown> };
export type PluginResponse = PluginRequest;

export type HttpTransportOptions = {
	credentials: { resolveCredential(name: string): Promise<ResolvedCredential | undefined> };
	allowRemote?: boolean;
};

export type HttpTransport = {
	request(message: PluginRequest, options?: { timeoutMs?: number }): Promise<PluginResponse>;
};

const JSON_TYPE = "application/json";

function endpointOf(manifest: PluginManifest, allowRemote: boolean): URL {
	const { name } = manifest;
	if (manifest.transport !== "http" || manifest.endpoint === undefined)
		throw new PluginTransportError("refused", `${name}: plugin is not on the http transport with an endpoint. Next: use the http transport in plugin.toml.`);
	const problem = checkHttpEndpoint(manifest.endpoint, manifest.remote);
	if (problem !== undefined) throw new PluginTransportError("refused", `${name}: ${problem}. Next: fix endpoint in plugin.toml.`);
	const url = new URL(manifest.endpoint);
	if (manifest.remote && !allowRemote)
		throw new PluginTransportError(
			"refused",
			`${name}: plugin is remote but plugins.${name}.allow_remote is not true. Next: run dg config set plugins.${name}.allow_remote true if you trust ${url.host}.`,
		);
	return url;
}

function routeUrl(base: URL, route: Route): string {
	const url = new URL(base);
	url.pathname = `${base.pathname.replace(/\/+$/, "")}${route}`;
	return url.href;
}

async function readCapped(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (declared > limit) {
		await response.body?.cancel();
		throw new PluginTransportError("oversize", `response is ${declared} bytes, the limit is ${limit}. Next: have the plugin send less.`);
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body?.getReader();
	while (reader) {
		signal.throwIfAborted();
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > limit) {
			await reader.cancel();
			throw new PluginTransportError("oversize", `response is over ${limit} bytes. Next: have the plugin send less.`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

function parseObject(bytes: Uint8Array, redact: (text: string) => string, what: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {}
	throw new PluginTransportError("plugin", redact(`${what} is not a JSON object. Next: fix the plugin.`));
}

export function httpTransport(manifest: PluginManifest, options: HttpTransportOptions): HttpTransport {
	const base = endpointOf(manifest, options.allowRemote === true);
	const { name } = manifest;
	const credential = pluginTokenCredential(name);
	let token: string | undefined;

	const resolveToken = async (): Promise<string> => {
		if (token !== undefined) return token;
		let found: ResolvedCredential | undefined;
		try {
			found = await options.credentials.resolveCredential(credential);
		} catch {
			throw new PluginTransportError("auth", `${name}: could not read credential ${credential}. Next: start dg agent, then run dg credentials set ${credential}.`);
		}
		if (found === undefined) throw new PluginTransportError("auth", `${name}: no token stored. Next: run dg credentials set ${credential}.`);
		token = found.value;
		return token;
	};

	const redactWith = (secret: string) => (text: string) => (secret === "" ? text : text.split(secret).join("[redacted]"));

	return {
		async request({ route, body }, { timeoutMs = ROUTE_TIMEOUT_MS[route] } = {}) {
			validateMessage(route, "request", body);
			const payload = JSON.stringify(body);
			if (Buffer.byteLength(payload) > FRAME_MAX_PAYLOAD_BYTES)
				throw new PluginTransportError("oversize", `${name}: request is over ${FRAME_MAX_PAYLOAD_BYTES} bytes. Next: send a smaller body.`);
			const secret = await resolveToken();
			const redact = redactWith(secret);
			const signal = AbortSignal.timeout(timeoutMs);
			try {
				const response = await fetch(routeUrl(base, route), {
					method: "POST",
					headers: { authorization: `Bearer ${secret}`, "content-type": JSON_TYPE, accept: JSON_TYPE, connection: "keep-alive" },
					body: payload,
					redirect: "error",
					signal,
				});
				const bytes = await readCapped(response, FRAME_MAX_PAYLOAD_BYTES, signal);
				if (response.status === 401 || response.status === 403) {
					token = undefined;
					throw new PluginTransportError("auth", `${name}: the plugin refused the token (HTTP ${response.status}). Next: run dg credentials set ${credential}.`);
				}
				const parsed = parseObject(bytes, redact, `${name}: response`);
				if (!response.ok) {
					const code = typeof parsed.code === "string" ? parsed.code : `http-${response.status}`;
					const message = typeof parsed.message === "string" ? parsed.message : "no message";
					throw new PluginTransportError("plugin", redact(`${name}: ${code}: ${message}`));
				}
				validateMessage(route, "response", parsed);
				return { route, body: parsed };
			} catch (error) {
				if (error instanceof DgCliError) throw error;
				if (signal.aborted)
					throw new PluginTransportError("timeout", `${name}: ${route} took over ${timeoutMs} ms. Next: check the plugin is healthy, then retry.`);
				throw new PluginTransportError("unreachable", `${name}: cannot reach ${base.host}. Next: start the plugin, then run dg plugin verify.`);
			}
		},
	};
}
