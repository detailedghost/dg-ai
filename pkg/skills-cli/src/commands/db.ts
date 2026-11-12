import type { Command } from "commander";
import { registerLazyLegacy } from "../utils/lazy-command";

const description = `Query PostgreSQL and Snowflake databases with read-safe defaults.

Flags: --write, --limit N, --format tsv|json|markdown, --max-cell N, --schema S, -f file.sql`;

export function registerDb(program: Command): void {
	registerLazyLegacy(program, {
		name: "db",
		description,
		load: async () => (await import("../db")).dbSpec,
	});
}
