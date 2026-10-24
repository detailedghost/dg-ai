import { afterAll, afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { PROTO_MARKER_KEY } from "@dg/common";
import {
	PROTO_HAS_PENDING,
	PROTO_NOT_READY,
	PROTO_PROGRESS,
	PROTO_SAVE_STYLE_GUIDE,
} from "@/lib/features/prototype";

const defineContentScriptDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"defineContentScript",
);
type CapturedContentConfig = {
	main(ctx: never): Promise<void>;
};
let capturedContentConfig: CapturedContentConfig | undefined;
Object.defineProperty(globalThis, "defineContentScript", {
	configurable: true,
	value: <T>(config: T) => {
		capturedContentConfig = config as CapturedContentConfig;
		return config;
	},
});

await import("../entrypoints/demo-tour.content");

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

function markedUrl(base: string, payload: unknown): string {
	const encoded = gzipSync(Buffer.from(JSON.stringify(payload), "utf8")).toString(
		"base64url",
	);
	return `${base}#${PROTO_MARKER_KEY}=${encoded}`;
}

const savedGlobals = {
	location: undefined as PropertyDescriptor | undefined,
	history: undefined as PropertyDescriptor | undefined,
	document: undefined as PropertyDescriptor | undefined,
	chrome: undefined as PropertyDescriptor | undefined,
};

function stubGlobals(options: {
	href: string;
	pending?: boolean;
	documentOverrides?: Partial<{ title: string; querySelector(selector: string): unknown }>;
}): { sent: Array<Record<string, unknown>> } {
	savedGlobals.location = Object.getOwnPropertyDescriptor(globalThis, "location");
	savedGlobals.history = Object.getOwnPropertyDescriptor(globalThis, "history");
	savedGlobals.document = Object.getOwnPropertyDescriptor(globalThis, "document");
	savedGlobals.chrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

	const url = new URL(options.href);
	const sent: Array<Record<string, unknown>> = [];
	const fakeLocation = {
		href: options.href,
		origin: url.origin,
		pathname: url.pathname,
	};
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: fakeLocation,
	});
	Object.defineProperty(globalThis, "history", {
		configurable: true,
		value: {
			state: null,
			replaceState(_state: unknown, _title: string, nextUrl: string) {
				fakeLocation.href = nextUrl;
			},
		},
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			title: "",
			querySelector: () => null,
			...options.documentOverrides,
		},
	});
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			runtime: {
				sendMessage: (message: Record<string, unknown>) => {
					sent.push(message);
					if (message.type === PROTO_HAS_PENDING) {
						return Promise.resolve({ pending: options.pending ?? true });
					}
					return Promise.resolve();
				},
			},
		},
	});
	return { sent };
}

afterEach(() => {
	for (const key of ["location", "history", "document", "chrome"] as const) {
		const descriptor = savedGlobals[key];
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
		savedGlobals[key] = undefined;
	}
});

test("a malformed prototype marker claims the load before demo initialization", async () => {
	const locationDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"location",
	);
	const historyDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"history",
	);
	let replacedUrl: string | undefined;
	const originalState = { preserved: "history state" };
	let replacementState: unknown;
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: {
			href: "https://example.test/account#_proto=%%%&_demo=leave-intact",
		},
	});
	Object.defineProperty(globalThis, "history", {
		configurable: true,
		value: {
			state: originalState,
			replaceState(state: unknown, _unused: string, url: string) {
				replacementState = state;
				replacedUrl = url;
			},
		},
	});

	try {
		expect(capturedContentConfig).toBeDefined();
		await capturedContentConfig!.main(undefined as never);
		expect(replacedUrl).toBe("https://example.test/account#_demo=leave-intact");
		expect(replacementState).toBe(originalState);
	} finally {
		if (locationDescriptor) {
			Object.defineProperty(globalThis, "location", locationDescriptor);
		} else {
			Reflect.deleteProperty(globalThis, "location");
		}
		if (historyDescriptor) {
			Object.defineProperty(globalThis, "history", historyDescriptor);
		} else {
			Reflect.deleteProperty(globalThis, "history");
		}
	}
});

test("reports PROTO_NOT_READY instead of scraping when the landed page looks like a sign-in wall", async () => {
	const href = "https://example.test/login?next=/account";
	const url = markedUrl(href, {
		phase: "scrape",
		slug: "account-summary",
		expectedUrl: "https://example.test/account",
	});
	const { sent } = stubGlobals({
		href: url,
		documentOverrides: {
			querySelector: (selector: string) =>
				selector === 'input[type="password"]' ? {} : null,
		},
	});

	expect(capturedContentConfig).toBeDefined();
	await capturedContentConfig!.main(undefined as never);

	expect(sent).toHaveLength(2);
	expect(sent[0]).toEqual({ type: PROTO_HAS_PENDING });
	expect(sent[1]).toEqual({
		type: PROTO_NOT_READY,
		error: {
			code: "login-page",
			message:
				"The page looks like a sign-in page. Authenticate in this browser profile and retry.",
			landedUrl: href,
		},
	});
	expect(sent.some((message) => message.type === PROTO_SAVE_STYLE_GUIDE)).toBe(
		false,
	);
});

test("reports PROTO_PROGRESS before scraping when the landed page is ready", async () => {
	const href = "https://example.test/account";
	const url = markedUrl(href, {
		phase: "scrape",
		slug: "account-summary",
		expectedUrl: href,
	});
	const { sent } = stubGlobals({ href: url });

	expect(capturedContentConfig).toBeDefined();
	await expect(capturedContentConfig!.main(undefined as never)).rejects.toThrow();

	expect(sent[0]).toEqual({ type: PROTO_HAS_PENDING });
	expect(sent[1]).toEqual({
		type: PROTO_PROGRESS,
		status: "ready; scraping the style guide",
	});
});

test("does not plant a marked page when the tab has no pending relay request", async () => {
	const href = "https://example.test/account";
	const url = markedUrl(href, {
		phase: "plant",
		slug: "account-summary",
		expectedUrl: href,
		plan: {
			slug: "account-summary",
			mode: "replace",
			variations: [
				{ key: "compact", label: "Compact", html: "<p>Hi</p>", css: "" },
			],
		},
	});
	const { sent } = stubGlobals({ href: url, pending: false });

	expect(capturedContentConfig).toBeDefined();
	await capturedContentConfig!.main(undefined as never);

	expect(sent).toEqual([{ type: PROTO_HAS_PENDING }]);
	expect(sent.some((message) => message.type === PROTO_PROGRESS)).toBe(false);
	expect(sent.some((message) => message.type === PROTO_SAVE_STYLE_GUIDE)).toBe(
		false,
	);
});
