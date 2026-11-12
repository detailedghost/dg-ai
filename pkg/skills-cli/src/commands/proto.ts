import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

export function registerProto(program: Command): void {
	registerLazyRaw(program, {
		name: "proto",
		description: "prototype locally (default) or inside a live page with --ext",
		load: () => import("../proto/cli"),
	});
}
