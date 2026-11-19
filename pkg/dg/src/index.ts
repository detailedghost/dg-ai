#!/usr/bin/env bun
import { exitAfterDrain } from "@dg/common/async";
import { normalizeDgHome } from "@dg/common/node/dg-paths";
import { main } from "./main";

if (import.meta.main) {
	normalizeDgHome();
	await exitAfterDrain(
		await main(process.argv.slice(2), {
			"dg-daemon": () => import("@dg/dg-daemon/main"),
			"dg-skills": () => import("@dg/skills-cli/main"),
			"dg-agent": () => import("@dg/dg-agent/main"),
		}),
	);
}
