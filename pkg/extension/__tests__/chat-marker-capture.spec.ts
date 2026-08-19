/**
 * entrypoints/chat-marker-capture.content.ts — the loopback-only content script
 * that parses, relays, and strips the `_chat` marker. Follows proto-content.spec.ts's
 * technique: stub WXT's defineContentScript macro, capture the real config, invoke it.
 */

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import type { SessionBootstrap } from "@dg/common";
import { MSG } from "@/lib/chat-messages";
import { stripChatMarker } from "@/utils/chat-marker";

type CapturedContentConfig = {
	matches?: string[];
	runAt?: string;
	main(ctx: never): unknown;
};

const defineContentScriptDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"defineContentScript",
);
let capturedContentConfig: CapturedContentConfig | undefined;
Object.defineProperty(globalThis, "defineContentScript", {
	configurable: true,
	value: <T>(config: T) => {
		capturedContentConfig = config as CapturedContentConfig;
		return config;
	},
});

await import("../entrypoints/chat-marker-capture.content");

afterAll(() => {
	if (defineContentScriptDescriptor) {
		Object.defineProperty(
			globalThis,
			"defineContentScript",
			defineContentScriptDescriptor,
		);
	} else {
		Reflect.deleteProperty(globalThis, "defineContentScript");
	}
});

const originalLocation = Object.getOwnPropertyDescriptor(
	globalThis,
	"location",
);
const originalHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

afterEach(() => {
	if (originalLocation) {
		Object.defineProperty(globalThis, "location", originalLocation);
	} else {
		Reflect.deleteProperty(globalThis, "location");
	}
	if (originalHistory) {
		Object.defineProperty(globalThis, "history", originalHistory);
	} else {
		Reflect.deleteProperty(globalThis, "history");
	}
	if (originalChrome) {
		Object.defineProperty(globalThis, "chrome", originalChrome);
	} else {
		Reflect.deleteProperty(globalThis, "chrome");
	}
});

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

/** base64url(JSON), no compression — plan.md's execute-mode layer-1 transport ratification. */
function encodeMarkerPayload(payload: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Swap in a plain location/history stub; replaceState just records what it was given. */
function withLocation(href: string): { replacedUrl(): string | undefined } {
	let replacedUrl: string | undefined;
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { href },
	});
	Object.defineProperty(globalThis, "history", {
		configurable: true,
		value: {
			state: null,
			replaceState(_state: unknown, _title: string, url: string) {
				replacedUrl = url;
			},
		},
	});
	return { replacedUrl: () => replacedUrl };
}

test("the manifest match pattern is loopback-only, never all-urls", () => {
	expect(capturedContentConfig?.matches).toEqual(["http://127.0.0.1/*"]);
	expect(capturedContentConfig?.matches).not.toContain("<all_urls>");
});

test("captures at document_start, before any other page script can read the token", () => {
	expect(capturedContentConfig?.runAt).toBe("document_start");
});

test("relays a captured bootstrap to the background and strips the marker from the URL", async () => {
	const bootstrap = makeBootstrap();
	const sendMessage = mock(() => undefined);
	Object.assign(globalThis, { chrome: { runtime: { sendMessage } } });
	const url = `http://127.0.0.1:4317/bootstrap#_chat=${encodeMarkerPayload(bootstrap)}&kept=1`;
	const { replacedUrl } = withLocation(url);

	await capturedContentConfig?.main(undefined as never);

	expect(sendMessage).toHaveBeenCalledTimes(1);
	expect(sendMessage).toHaveBeenCalledWith({
		type: MSG.markerCaptured,
		bootstrap,
	});
	// Derived from the real strip transform, not a hardcoded duplicate string.
	expect(replacedUrl()).toBe(stripChatMarker(url));
	expect(replacedUrl()).toContain("kept=1");
	expect(replacedUrl()).not.toContain("_chat=");
});

test("does nothing when the page carries no _chat marker", async () => {
	const sendMessage = mock(() => undefined);
	Object.assign(globalThis, { chrome: { runtime: { sendMessage } } });
	const { replacedUrl } = withLocation("http://127.0.0.1:4317/bootstrap");

	await capturedContentConfig?.main(undefined as never);

	expect(sendMessage).not.toHaveBeenCalled();
	expect(replacedUrl()).toBeUndefined();
});

/**
 * Mirrors demo-tour.content.ts's runProto convention: any `_chat` marker — valid or
 * malformed — still gets stripped from the address bar, but a malformed one never relays.
 */
test("strips a malformed _chat marker without relaying it to the background", async () => {
	const sendMessage = mock(() => undefined);
	Object.assign(globalThis, { chrome: { runtime: { sendMessage } } });
	const url = "http://127.0.0.1:4317/bootstrap#_chat=not-valid-base64json%%%";
	const { replacedUrl } = withLocation(url);

	await capturedContentConfig?.main(undefined as never);

	expect(sendMessage).not.toHaveBeenCalled();
	expect(replacedUrl()).toBe(stripChatMarker(url));
});
