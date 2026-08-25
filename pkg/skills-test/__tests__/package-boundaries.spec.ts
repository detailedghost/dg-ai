import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const CLI_WIRE_TYPES = [
	"CliRecvRequest",
	"CliRecvResult",
	"CliAckRequest",
	"CliSendRequest",
	"CliProgressRequest",
	"CliManifestPublishRequest",
	"CliFrame",
	"CliRequest",
];

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...tsFiles(p));
		else if (entry.endsWith(".ts")) out.push(p);
	}
	return out;
}

function importedFromCommon(source: string): string[] {
	const match =
		/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']@dg\/common["'];/.exec(
			source,
		);
	if (!match) return [];
	return match[1]
		.split(",")
		.map((s) => s.trim().replace(/^type\s+/, ""))
		.filter(Boolean);
}

describe("the CLI wire contract lives in @dg/common, where both packages can reach it", () => {
	const wire = readRepoFile("pkg", "common", "src", "cli-wire.ts");

	test("every frame type the agent CLI and the daemon exchange is declared there", () => {
		for (const name of CLI_WIRE_TYPES) {
			expect(wire).toContain(`export type ${name}`);
		}
	});

	test("the barrel re-exports it, so a consumer imports from @dg/common", () => {
		expect(readRepoFile("pkg", "common", "src", "index.ts")).toContain(
			'export * from "./cli-wire"',
		);
	});

	test("the daemon keeps no private copy for the split to fork away from", () => {
		expect(
			existsSync(
				join(REPO_ROOT, "pkg", "dg-daemon", "src", "commands", "wire.ts"),
			),
		).toBe(false);

		const consumers = [
			["pkg", "dg-agent", "src", "commands.ts"],
			["pkg", "dg-agent", "src", "client.ts"],
			["pkg", "dg-daemon", "src", "server", "frame-handlers.ts"],
		];
		for (const rel of consumers) {
			const imported = importedFromCommon(readRepoFile(...rel));
			expect(imported.some((name) => CLI_WIRE_TYPES.includes(name))).toBe(true);
		}

		for (const root of ["dg-daemon", "dg-agent"]) {
			for (const file of tsFiles(join(REPO_ROOT, "pkg", root, "src"))) {
				const source = readFileSync(file, "utf8");
				for (const name of CLI_WIRE_TYPES) {
					expect(source).not.toContain(`type ${name} =`);
					expect(source).not.toContain(`interface ${name} `);
				}
			}
		}
	});
});
