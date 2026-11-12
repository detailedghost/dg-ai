#!/usr/bin/env bun
import { exitAfterDrain } from "@dg/common/async";
import { normalizeDgHome } from "@dg/common/node/dg-paths";
import { main } from "./main";

if (import.meta.main) {
	normalizeDgHome();
	await exitAfterDrain(await main(process.argv.slice(2)));
}
