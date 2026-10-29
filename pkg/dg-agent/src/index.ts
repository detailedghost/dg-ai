#!/usr/bin/env bun
import { exitAfterDrain } from "@dg/common/async";
import { main } from "./main";

if (import.meta.main) await exitAfterDrain(await main(process.argv.slice(2)));
