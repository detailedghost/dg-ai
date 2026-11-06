import { describe, expect, it } from "bun:test";
import {
	type AnyRelayFeature,
	bootstrapHint,
	RELAY_FEATURES,
} from "../src/index";
import { TEST_RELAY } from "./utils/relay-fixtures";

const FEATURES: readonly AnyRelayFeature[] = [...RELAY_FEATURES, TEST_RELAY];

describe.each(FEATURES.map((feature) => [feature.name, feature] as const))(
	"relay table %s",
	(_name, feature) => {
		const count = (check: string) =>
			feature.checks.filter((entry) => entry.check === check).length;

		it.each(["active", "replay", "burn", "peers"])(
			"has exactly one %s check",
			(check) => {
				expect(count(check)).toBe(1);
			},
		);

		it("has a canceled string if and only if it has a CLI cancel frame", () => {
			expect(feature.strings.canceled !== undefined).toBe(
				feature.frames.cliCancel !== undefined,
			);
		});

		it("has a rejected string if and only if it has a rejected entry", () => {
			expect(feature.strings.rejected !== undefined).toBe(
				feature.rejected !== undefined,
			);
		});

		it("has an unreadable fail-all string if and only if the flag is set", () => {
			expect(feature.strings.unreadableFailAll !== undefined).toBe(
				feature.flags.failAllOnUnreadable,
			);
		});

		it("has distinct frame names", () => {
			const names = Object.values(feature.frames);
			expect(new Set(names).size).toBe(names.length);
		});
	},
);

const VERSIONED = FEATURES.filter((feature) =>
	feature.checks.some((entry) => entry.check === "version"),
);

describe("relay version checks", () => {
	it("is declared by at least one feature", () => {
		expect(VERSIONED.length).toBeGreaterThan(0);
	});

	it.each(VERSIONED.map((feature) => [feature.name, feature] as const))(
		"places the version check of %s after its peers check",
		(_name, feature) => {
			const order = feature.checks.map((entry) => entry.check);
			expect(order.indexOf("version")).toBeGreaterThan(order.indexOf("peers"));
		},
	);
});

describe("relay frame type names", () => {
	it("are unique across all features", () => {
		const names = FEATURES.flatMap((feature) => Object.values(feature.frames));
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("bootstrapHint", () => {
	it("names the port when it is known", () => {
		expect(bootstrapHint(4321)).toBe(
			"http://127.0.0.1:4321/start#_chat=<base64url JSON of port, sessionId, token, and agentIdentity>",
		);
	});

	it("keeps the literal placeholder when the port is zero", () => {
		expect(bootstrapHint(0)).toBe(bootstrapHint());
	});

	it("keeps the literal placeholder when the port is unknown", () => {
		expect(bootstrapHint()).toBe(
			"http://127.0.0.1:<port>/start#_chat=<base64url JSON of port, sessionId, token, and agentIdentity>",
		);
	});
});
