import { DgCliError } from "../errors";

export const PROTOCOL_VERSION = 1;

export const FRAME_HEADER_BYTES = 12;
export const FRAME_MAX_PAYLOAD_BYTES = 1_048_576;
export const UDP_MAX_FRAME_BYTES = 1_200;

export const FRAME_FLAG_RESPONSE = 0b001;
export const FRAME_FLAG_ERROR = 0b010;
export const FRAME_FLAG_EVENT = 0b100;
const FRAME_FLAGS_MASK = 0b111;

export const ENCODINGS = ["json", "msgpack"] as const;
export type Encoding = (typeof ENCODINGS)[number];

export const ROUTES = ["/v1/hello", "/v1/hook/decide", "/v1/job/run", "/v1/job/status", "/v1/skill/describe", "/v1/health"] as const;
export type Route = (typeof ROUTES)[number];

export const ROUTE_TIMEOUT_MS: Readonly<Record<Route, number>> = {
	"/v1/hello": 1_000,
	"/v1/hook/decide": 2_000,
	"/v1/job/run": 10_000,
	"/v1/job/status": 2_000,
	"/v1/skill/describe": 2_000,
	"/v1/health": 1_000,
};

export const HOOK_LATENCY_BUDGET_P99_MS = { ipc: 1, tcp: 2, http: 5 } as const;

export type Frame = { encoding: Encoding; flags: number; requestId: number; payload: Uint8Array };
export type DecodedFrame = Frame & { version: number };

export type FrameErrorCode = "short-header" | "bad-version" | "bad-encoding" | "reserved-flags" | "oversize" | "truncated-payload" | "trailing-bytes";

function frameError(code: FrameErrorCode, detail: string, next: string): never {
	throw new DgCliError(`dg plugin: frame ${code}: ${detail}. Next: ${next}`);
}

export function pluginTokenCredential(plugin: string): string {
	return `plugin-${plugin}-token`;
}

export function encodeFrame({ encoding, flags, requestId, payload }: Frame): Uint8Array {
	if (payload.length > FRAME_MAX_PAYLOAD_BYTES)
		frameError("oversize", `payload is ${payload.length} bytes, the limit is ${FRAME_MAX_PAYLOAD_BYTES}`, "send a smaller payload");
	const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, PROTOCOL_VERSION);
	view.setUint8(1, ENCODINGS.indexOf(encoding));
	view.setUint16(2, flags, false);
	view.setUint32(4, requestId, false);
	view.setUint32(8, payload.length, false);
	out.set(payload, FRAME_HEADER_BYTES);
	return out;
}

/** Decodes exactly one frame; the buffer must hold the header and the whole payload and nothing else. */
export function decodeFrame(bytes: Uint8Array): DecodedFrame {
	if (bytes.length < FRAME_HEADER_BYTES)
		frameError("short-header", `got ${bytes.length} bytes, a header is ${FRAME_HEADER_BYTES}`, "read 12 bytes before you decode");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = view.getUint8(0);
	if (version !== PROTOCOL_VERSION)
		frameError("bad-version", `version ${version}, this dg speaks ${PROTOCOL_VERSION}`, "update the plugin to protocol 1");
	const encoding = ENCODINGS[view.getUint8(1)];
	if (encoding === undefined)
		frameError("bad-encoding", `encoding ${view.getUint8(1)} is not 0 (json) or 1 (msgpack)`, "negotiate the encoding in hello");
	const flags = view.getUint16(2, false);
	if ((flags & ~FRAME_FLAGS_MASK) !== 0)
		frameError("reserved-flags", `flags 0x${flags.toString(16)} set a reserved bit`, "send zero in every reserved flag bit");
	const length = view.getUint32(8, false);
	if (length > FRAME_MAX_PAYLOAD_BYTES)
		frameError("oversize", `length ${length}, the limit is ${FRAME_MAX_PAYLOAD_BYTES}`, "close the connection and send smaller payloads");
	const end = FRAME_HEADER_BYTES + length;
	if (bytes.length < end) frameError("truncated-payload", `header says ${length} payload bytes, got ${bytes.length - FRAME_HEADER_BYTES}`, "read the full payload");
	if (bytes.length > end) frameError("trailing-bytes", `${bytes.length - end} bytes follow the payload`, "split the stream at each header length");
	return { version, encoding, flags, requestId: view.getUint32(4, false), payload: bytes.subarray(FRAME_HEADER_BYTES, end) };
}

type Body = Record<string, unknown>;
type Check = (body: Body) => void;

function bad(key: string, message: string): never {
	throw new DgCliError(`dg plugin: ${key}: ${message}. Next: fix the message, see docs/plugin-protocol.md.`);
}

function isBody(value: unknown): value is Body {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(body: Body, name: string): string {
	const value = body[name];
	if (typeof value !== "string" || value.length === 0) bad(`body.${name}`, `${name} is required and must be a non-empty string`);
	return value;
}

function optionalString(body: Body, name: string): void {
	if (body[name] !== undefined && typeof body[name] !== "string") bad(`body.${name}`, `${name} must be a string`);
}

function stringList(body: Body, name: string): string[] {
	const value = body[name];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) bad(`body.${name}`, `${name} must be a list of strings`);
	return value as string[];
}

function oneOf(body: Body, name: string, allowed: readonly string[]): string {
	const value = body[name];
	if (typeof value !== "string" || !allowed.includes(value)) bad(`body.${name}`, `${name} must be one of ${allowed.join(", ")}`);
	return value;
}

function protocolOne(body: Body): void {
	if (body.protocol !== PROTOCOL_VERSION) bad("body.protocol", `protocol must be protocol ${PROTOCOL_VERSION}, got ${JSON.stringify(body.protocol)}`);
}

function empty(): void {}

const CHECKS: Record<Route, { request: Check; response: Check }> = {
	"/v1/hello": {
		request(body) {
			protocolOne(body);
			if (!stringList(body, "encodings").includes("json")) bad("body.encodings", "encodings must include json, every plugin reads json");
			stringList(body, "capabilities");
			optionalString(body, "token");
		},
		response(body) {
			protocolOne(body);
			oneOf(body, "encoding", ENCODINGS);
			stringList(body, "capabilities");
		},
	},
	"/v1/hook/decide": {
		request(body) {
			requireString(body, "event");
			optionalString(body, "tool");
			if (body.input !== undefined && !isBody(body.input)) bad("body.input", "input must be an object");
		},
		response(body) {
			oneOf(body, "decision", ["allow", "deny", "ask"]);
			optionalString(body, "reason");
		},
	},
	"/v1/job/run": {
		request(body) {
			requireString(body, "job");
			if (body.args !== undefined) stringList(body, "args");
		},
		response(body) {
			requireString(body, "runId");
		},
	},
	"/v1/job/status": {
		request(body) {
			requireString(body, "runId");
		},
		response(body) {
			oneOf(body, "state", ["queued", "running", "succeeded", "failed"]);
			if (body.exitCode !== undefined && !Number.isInteger(body.exitCode)) bad("body.exitCode", "exitCode must be an integer");
		},
	},
	"/v1/skill/describe": {
		request: empty,
		response(body) {
			requireString(body, "name");
			requireString(body, "description");
			stringList(body, "files");
		},
	},
	"/v1/health": {
		request: empty,
		response(body) {
			oneOf(body, "status", ["ok", "degraded"]);
			requireString(body, "version");
		},
	},
};

function isRoute(route: string): route is Route {
	return (ROUTES as readonly string[]).includes(route);
}

export function validateMessage(route: string, direction: "request" | "response", body: unknown): void {
	if (!isRoute(route)) bad("route", `${route} is not a v1 route; the routes are ${ROUTES.join(", ")}`);
	if (!isBody(body)) bad("body", "body must be an object");
	CHECKS[route][direction](body);
}
