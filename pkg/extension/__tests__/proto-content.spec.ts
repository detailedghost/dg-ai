import { afterAll, expect, test } from "bun:test";

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
