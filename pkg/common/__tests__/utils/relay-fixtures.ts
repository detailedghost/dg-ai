import { requireRecord, requireString } from "../../src/assert";
import { defineRelayFeature } from "../../src/relay-format";

export type TestCliRequest = {
	type: "cli-test-request";
	requestId: string;
	tag?: string;
	timeoutMs?: number;
};

export type TestRelayBodies = {
	cliRequest: TestCliRequest;
	cliCancel: { type: "cli-test-cancel"; requestId: string };
	browserRequest: { requestId: string; tag?: string; timeoutMs: number };
	browserCancel: { requestId: string };
	browserResult: {
		requestId: string;
		ok: boolean;
		data?: string;
		error?: string;
	};
	browserProgress: { requestId: string; status: string };
};

export const TEST_RELAY = defineRelayFeature<TestRelayBodies>()({
	name: "test",
	frames: {
		cliRequest: "cli-test-request",
		cliResult: "cli-test-result",
		cliCancel: "cli-test-cancel",
		browserRequest: "test-browser-request",
		browserResult: "test-browser-result",
		browserCancel: "test-browser-cancel",
		browserProgress: "test-browser-progress",
	},
	validators: {
		"test-browser-request": () => {},
		"test-browser-cancel": () => {},
		"test-browser-result": () => {},
		"test-browser-progress": () => {},
	},
	inbound: ["test-browser-result", "test-browser-progress"],
	validateCliRequest(value): TestCliRequest {
		requireRecord(value, "test request");
		requireString(value.requestId, "test request.requestId", { nonEmpty: true });
		return {
			type: "cli-test-request",
			requestId: value.requestId,
			tag: typeof value.tag === "string" ? value.tag : undefined,
			timeoutMs:
				typeof value.timeoutMs === "number" ? value.timeoutMs : undefined,
		};
	},
	validateCliCancel(value) {
		requireRecord(value, "test cancel");
		requireString(value.requestId, "test cancel.requestId", { nonEmpty: true });
		return { requestId: value.requestId };
	},
	caps: { pending: 2, perRequester: 1, sessionIds: 3 },
	timeoutMs: (cli) => cli.timeoutMs ?? 5000,
	toBrowserRequest: (cli, timeoutMs) => ({ tag: cli.tag, timeoutMs }),
	fromBrowserRequest: (frame) => frame.tag,
	toCliResult: (frame) =>
		frame.ok
			? { ok: true, data: frame.data }
			: { ok: false, error: frame.error },
	checks: [
		{ check: "active", refusal: "test: needs an active session" },
		{ check: "pendingDuplicate", refuseOtherRequester: "test: duplicate" },
		{ check: "replay", refusal: "test: id already used" },
		{ check: "cap", of: ["sessionIds"], refusal: "test: out of ids" },
		{
			check: "cap",
			of: ["requester", "pending"],
			refusal: "test: too many pending",
		},
		{
			check: "peers",
			multiple: "test: several peers",
			none: ({ sessionId }) => `test: no peer on ${sessionId}`,
		},
		{ check: "burn" },
		{
			check: "version",
			accepts: (version) => version === "9.0.0",
			refusal: "test: old extension",
		},
	],
	strings: {
		activeRequired: "test: needs an active session",
		sessionClosed: "test: session closed",
		timeout: ({ timeoutMs, lastStatus }) =>
			`test: timed out after ${timeoutMs}ms; status ${lastStatus ?? "none"}`,
		requesterDisconnected: "test: requester gone",
		extensionDisconnected: "test: extension gone",
		sendFailed: "test: send failed",
		canceled: "test: canceled",
		rejected: (detail) => `test: rejected ${detail}`,
		unreadableFailAll: "test: unreadable",
		extensionFailed: "test: extension failed",
	},
	rejected: { oversizedReason: "test: too big", afterOversized: "return" },
	flags: { failAllOnUnreadable: true },
});
