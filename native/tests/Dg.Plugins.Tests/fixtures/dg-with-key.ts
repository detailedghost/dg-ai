import { mock } from "bun:test";
import { exitAfterDrain } from "@dg/common/async";
import * as common from "@dg/common/node";
import { normalizeDgHome } from "@dg/common/node/dg-paths";
import { main } from "../../../../pkg/dg/src/main";

const value = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";
mock.module("@dg/common/node", () => ({
	...common,
	createCredentialClient: () => ({ get: async () => ({ value }), set: async () => undefined, close: () => undefined }),
}));
normalizeDgHome();
await exitAfterDrain(
	await main(process.argv.slice(2), {
		"dg-daemon": () => import("@dg/dg-daemon/main"),
		"dg-skills": () => import("@dg/skills-cli/main"),
		"dg-agent": () => import("@dg/dg-agent/main"),
	}),
);
