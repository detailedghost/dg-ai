import { describe, expect, it } from "bun:test";
import {
	type AnyRelayFeature,
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

describe.each(
	RELAY_FEATURES.filter((feature) => feature.name !== "pw-ext").map(
		(feature) => [feature.name, feature] as const,
	),
)("missing-peer hint of %s", (_name, feature) => {
	const peers = feature.checks.find((entry) => entry.check === "peers");
	const hint = (sessionId: string) => {
		if (peers?.check !== "peers") throw new Error("no peers check");
		return peers.none({ sessionId } as never);
	};

	it("tells the agent to start the session and install the extension", () => {
		expect(hint("sess-1")).toContain("Start the session with dg-agent start.");
		expect(hint("sess-1")).toContain("install it with dg-skills install");
	});

	it("prints no /start URL and no token placeholder", () => {
		expect(hint("sess-1")).not.toContain("/start#_chat=");
		expect(hint("sess-1")).not.toContain("token");
	});
});

describe("RELAY_FEATURES", () => {
	it("lists inbox, proto and pw-ext in that order", () => {
		expect(RELAY_FEATURES.map((feature) => feature.name)).toEqual([
			"inbox",
			"proto",
			"pw-ext",
		]);
	});
});
