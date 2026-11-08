import { expect, test } from "bun:test";
import { type SessionBootstrap, validateSessionBootstrap } from "@dg/common";
import { buildBootstrapUrl } from "@dg/common/node";
import {
	CHAT_MARKER_KEY,
	localPageUrl,
	readChatBootstrap,
	stripChatMarker,
} from "../src/chat-marker";

function makeBootstrap(
	overrides: Partial<SessionBootstrap> = {},
): SessionBootstrap {
	return {
		port: 4317,
		sessionId: "sess-abc123",
		token: "tok-xyz789",
		agentIdentity: "claude-orchestrator",
		...overrides,
	};
}

function encodeMarkerPayload(payload: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function urlWithChatMarker(payload: unknown, tail = ""): string {
	return `http://127.0.0.1:4317/bootstrap#_chat=${encodeMarkerPayload(payload)}${tail}`;
}

test("CHAT_MARKER_KEY is the _chat fragment key", () => {
	expect(CHAT_MARKER_KEY).toBe("_chat");
});

test("decodes a valid _chat marker into exactly the shared validator's SessionBootstrap", () => {
	const bootstrap = makeBootstrap();
	const expected = validateSessionBootstrap(bootstrap);
	expect(readChatBootstrap(urlWithChatMarker(bootstrap))).toEqual(expected);
});

test("rejects a marker missing required SessionBootstrap fields rather than returning a partial object", () => {
	const incomplete = { port: 4317, sessionId: "sess-abc123" };
	expect(() => validateSessionBootstrap(incomplete)).toThrow();
	expect(readChatBootstrap(urlWithChatMarker(incomplete))).toBeUndefined();
});

test("rejects a DaemonHandle-shaped payload as an invalid chat marker, not a half-filled bootstrap", () => {
	const lockfileShaped = {
		pid: 4242,
		port: 4317,
		instanceId: "instance-1",
		versions: { package: "1.0.0", protocol: 1 },
	};
	expect(readChatBootstrap(urlWithChatMarker(lockfileShaped))).toBeUndefined();
});

test("rejects a DaemonHandle-shaped payload that also carries a spurious agentIdentity (no token), not a corrupted bootstrap", () => {
	const daemonWithAgentIdentity = {
		pid: 4242,
		port: 4317,
		instanceId: "instance-1",
		versions: { package: "1.0.0", protocol: 1 },
		agentIdentity: "claude-orchestrator",
	};
	const result = readChatBootstrap(urlWithChatMarker(daemonWithAgentIdentity));
	expect(result).toBeUndefined();
});

test("rejects unparsable marker content without throwing", () => {
	const url = "http://127.0.0.1:4317/bootstrap#_chat=not-valid-base64json%%%";
	expect(() => readChatBootstrap(url)).not.toThrow();
	expect(readChatBootstrap(url)).toBeUndefined();
});

test("returns undefined when the URL carries no _chat marker at all", () => {
	expect(readChatBootstrap("http://127.0.0.1:4317/bootstrap")).toBeUndefined();
	expect(
		readChatBootstrap("http://127.0.0.1:4317/bootstrap#other=1"),
	).toBeUndefined();
});

test("strips only the _chat entry, preserving other fragment entries byte-for-byte", () => {
	const bootstrap = makeBootstrap();
	const url = urlWithChatMarker(bootstrap, "&kept=1");
	const stripped = stripChatMarker(url);
	expect(stripped).toBe("http://127.0.0.1:4317/bootstrap#kept=1");
	expect(stripped).not.toContain("_chat=");
});

test("strips to a bare URL with no # when nothing else remains in the fragment", () => {
	const bootstrap = makeBootstrap();
	const stripped = stripChatMarker(urlWithChatMarker(bootstrap));
	expect(stripped).toBe("http://127.0.0.1:4317/bootstrap");
});

test("leaves a URL with no _chat marker unchanged", () => {
	const url = "http://127.0.0.1:4317/bootstrap#kept=1";
	expect(stripChatMarker(url)).toBe(url);
});

test("leaves a URL with no fragment at all unchanged", () => {
	const url = "http://127.0.0.1:4317/bootstrap";
	expect(stripChatMarker(url)).toBe(url);
});

test("localPageUrl round-trips through readChatBootstrap", () => {
	const bootstrap = makeBootstrap();
	const url = localPageUrl({ port: bootstrap.port, path: "/chat", bootstrap });
	expect(readChatBootstrap(url)).toEqual(validateSessionBootstrap(bootstrap));
});

test("localPageUrl targets the loopback port and path and carries the token only in the fragment", () => {
	const bootstrap = makeBootstrap({ port: 4321 });
	const url = new URL(
		localPageUrl({ port: 4321, path: "/board", bootstrap }),
	);
	expect(url.origin).toBe("http://127.0.0.1:4321");
	expect(url.pathname).toBe("/board");
	expect(url.search).toBe("");
	expect(url.hash.startsWith(`#${CHAT_MARKER_KEY}=`)).toBe(true);
	expect(url.href).not.toContain("token=");
});

test("localPageUrl output ends with a padding-free base64url payload", () => {
	const bootstrap = makeBootstrap({ agentIdentity: "a" });
	const payload = localPageUrl({
		port: bootstrap.port,
		path: "/chat",
		bootstrap,
	}).split("#_chat=")[1];
	expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("localPageUrl equals the node buildBootstrapUrl output", () => {
	const bootstrap = makeBootstrap();
	expect(
		localPageUrl({ port: bootstrap.port, path: "/chat", bootstrap }),
	).toBe(buildBootstrapUrl(bootstrap.port, bootstrap, "/chat"));
});

test("localPageUrl encodes a non-ASCII agentIdentity like node and round-trips it", () => {
	const bootstrap = makeBootstrap({ agentIdentity: "agent \u00e9\u4e2d\u6587 \u{1F980}" });
	const url = localPageUrl({
		port: bootstrap.port,
		path: "/board",
		bootstrap,
	});
	expect(url).toBe(buildBootstrapUrl(bootstrap.port, bootstrap, "/board"));
	expect(readChatBootstrap(url)?.agentIdentity).toBe(bootstrap.agentIdentity);
});
