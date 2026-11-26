import { exitAfterDrain } from "@dg/common/async";
import { normalizeDgHome } from "@dg/common/node/dg-paths";
import { main } from "../../../../pkg/dg/src/main";
import { overrideApprovalKeys } from "../../../../pkg/skills-cli/src/plugin/approval";

const key = Buffer.from("00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f", "hex");
overrideApprovalKeys({ read: async () => key, ensure: async () => key });
normalizeDgHome();
await exitAfterDrain(
	await main(process.argv.slice(2), {
		"dg-daemon": () => import("@dg/dg-daemon/main"),
		"dg-skills": () => import("@dg/skills-cli/main"),
		"dg-agent": () => import("@dg/dg-agent/main"),
	}),
);
