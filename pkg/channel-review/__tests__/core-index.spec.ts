import { describe, expect, test } from "bun:test";
import * as api from "../src/index";

describe("channel-review package barrel", () => {
	test.each([
		"loadConfig",
		"resolveEnv",
		"rewriteConfigKey",
		"saveDefaultEnv",
		"channelReviewPaths",
		"createStateStore",
		"prKey",
		"parseTrigger",
		"parseReadiness",
		"parsePrUrl",
		"ERROR_CATALOG",
		"replyText",
		"transition",
		"createEngine",
		"aggregateOutcome",
		"formatStackSummary",
		"VERDICT_LABELS",
		"loadFunPool",
		"filterVerifiedFun",
		"pickFun",
		"decorateReply",
		"funVerdictFor",
		"VerdictError",
	])("exports %s", (name) => {
		expect((api as Record<string, unknown>)[name]).toBeDefined();
	});
});
