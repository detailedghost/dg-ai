// @ts-check
/**
 * Mutation testing for the chat-harness connection work.
 * Scoped to the modules added for attach, liveness, and the panel handshake,
 * and to the unit tests that cover them.
 *
 *   bunx stryker run
 */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	appendPlugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "all",
	inPlace: true,
	concurrency: 4,
	mutate: [
		"pkg/common/src/session-connect.ts",
		"pkg/common/src/redact.ts",
		"pkg/common/src/connection-drop.ts",
		"pkg/dg-daemon/src/session/liveness.ts",
		"pkg/dg-daemon/src/session/archive.ts",
		"pkg/dg-daemon/src/session/local-sessions.ts",
		"pkg/extension/lib/features/chat-connection.ts",
		"pkg/dg-agent/src/attach.ts",
		"pkg/dg-agent/src/next-step.ts",
	],
	testFiles: [
		"pkg/common/__tests__/session-connect.spec.ts",
		"pkg/common/__tests__/redact.spec.ts",
		"pkg/dg-daemon/__tests__/session/liveness.spec.ts",
		"pkg/dg-daemon/__tests__/session/archive.spec.ts",
		"pkg/dg-daemon/__tests__/session/local-sessions.spec.ts",
		"pkg/extension/__tests__/chat-connection.spec.ts",
		"pkg/extension/__tests__/chat-drop-log.spec.ts",
		"pkg/dg-agent/__tests__/attach.spec.ts",
		"pkg/dg-agent/__tests__/next-step.spec.ts",
	],
	bun: {
		timeout: 60_000,
		testFiles: [
			"pkg/common/__tests__/session-connect.spec.ts",
			"pkg/common/__tests__/redact.spec.ts",
			"pkg/dg-daemon/__tests__/session/liveness.spec.ts",
			"pkg/dg-daemon/__tests__/session/archive.spec.ts",
			"pkg/dg-daemon/__tests__/session/local-sessions.spec.ts",
			"pkg/extension/__tests__/chat-connection.spec.ts",
			"pkg/extension/__tests__/chat-drop-log.spec.ts",
			"pkg/dg-agent/__tests__/attach.spec.ts",
			"pkg/dg-agent/__tests__/next-step.spec.ts",
		],
	},
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/mutation.json" },
	thresholds: { high: 90, low: 80, break: null },
	tempDirName: ".stryker-tmp",
};

export default config;
