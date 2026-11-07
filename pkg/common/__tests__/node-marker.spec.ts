import { describe, expect, it } from "bun:test";
import { CHAT_MARKER_KEY, type SessionBootstrap } from "../src/index";
import { buildBootstrapUrl } from "../src/node/marker";

const bootstrap: SessionBootstrap = {
	port: 4321,
	sessionId: "session-1",
	token: "token-0000000000000000000000",
	agentIdentity: "claude",
};

function decode(url: string): unknown {
	const payload = url.split(`#${CHAT_MARKER_KEY}=`)[1] ?? "";
	return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("buildBootstrapUrl", () => {
	it("opens the chat page when no path is given", () => {
		const url = buildBootstrapUrl(bootstrap.port, bootstrap);
		expect(url.startsWith(`http://127.0.0.1:${bootstrap.port}/chat#${CHAT_MARKER_KEY}=`)).toBe(true);
		expect(decode(url)).toEqual(bootstrap);
	});

	it("opens the board page when asked", () => {
		const url = buildBootstrapUrl(bootstrap.port, bootstrap, "/board");
		expect(url.startsWith(`http://127.0.0.1:${bootstrap.port}/board#${CHAT_MARKER_KEY}=`)).toBe(true);
		expect(decode(url)).toEqual(bootstrap);
	});
});
