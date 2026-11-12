import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

export function registerErd(program: Command): void {
	registerLazyRaw(program, {
		name: "erd",
		description: "Generate architecture maps and render structured Mermaid diagrams.",
		load: async () => {
			const { erdSpec } = await import("../erd");
			return { main: (argv) => erdSpec.run(argv) };
		},
	});
}
