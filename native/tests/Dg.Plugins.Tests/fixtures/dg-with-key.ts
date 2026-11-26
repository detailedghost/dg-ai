import { createHmac, timingSafeEqual } from "node:crypto";
import { mock } from "bun:test";
import { exitAfterDrain } from "@dg/common/async";
import * as common from "@dg/common/node";
import { normalizeDgHome } from "@dg/common/node/dg-paths";
import { main } from "../../../../pkg/dg/src/main";

const key = Buffer.from("00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f", "hex");
const mac = (fields: string[]) => createHmac("sha256", key).update(["dg-plugin-approval-v1", ...fields].join("\0")).digest();
mock.module("@dg/common/node", () => ({
	...common,
	createCredentialClient: () => ({
		approvalSign: async (_purpose: string, fields: string[]) => mac(fields).toString("hex"),
		approvalVerify: async (_purpose: string, fields: string[], claimed: string) => {
			const claimedMac = Buffer.from(claimed, "hex");
			const expected = mac(fields);
			return claimedMac.length === expected.length && timingSafeEqual(expected, claimedMac);
		},
		close: () => undefined,
	}),
}));
normalizeDgHome();
await exitAfterDrain(
	await main(process.argv.slice(2), {
		"dg-daemon": () => import("@dg/dg-daemon/main"),
		"dg-skills": () => import("@dg/skills-cli/main"),
		"dg-agent": () => import("@dg/dg-agent/main"),
	}),
);
