import type { Command } from "commander";
import { erdSpec } from "../erd";
import { registerRawCommand } from "../utils/legacy-command";

export function registerErd(program: Command): void {
	registerRawCommand(program, erdSpec);
}
