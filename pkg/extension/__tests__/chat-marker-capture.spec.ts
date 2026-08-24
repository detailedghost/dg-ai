import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { MSG } from "@/lib/chat-messages";
import { stripChatMarker } from "@/utils/chat-marker";
import { captureGlobal, makeBootstrap } from "./utils/relay-harness";

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

const restoreLocation = captureGlobal("location");
const restoreHistory = captureGlobal("history");
const restoreChrome = captureGlobal("chrome");

afterEach(() => {
	restoreLocation();
	restoreHistory();
	restoreChrome();
});

function encodeMarkerPayload(payload: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

test("strips a malformed _chat marker without relaying it to the background", async () => {
	const sendMessage = mock(() => undefined);
	Object.assign(globalThis, { chrome: { runtime: { sendMessage } } });
	const url = "http://127.0.0.1:4317/bootstrap#_chat=not-valid-base64json%%%";
	const { replacedUrl } = withLocation(url);

	await capturedContentConfig?.main(undefined as never);

	expect(sendMessage).not.toHaveBeenCalled();
	expect(replacedUrl()).toBe(stripChatMarker(url));
});
