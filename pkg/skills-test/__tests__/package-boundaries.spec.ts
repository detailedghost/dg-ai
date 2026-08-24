import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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

	test("it pulls in no node: builtin, so the barrel stays browser-safe", () => {
		expect(wire).not.toContain('from "node:');
	});

	test("the daemon keeps no private copy for the split to fork away from", () => {
		expect(
			existsSync(
				join(REPO_ROOT, "pkg", "dg-daemon", "src", "commands", "wire.ts"),
			),
		).toBe(false);

		for (const rel of [
			["pkg", "dg-agent", "src", "commands.ts"],
			["pkg", "dg-agent", "src", "client.ts"],
			["pkg", "dg-daemon", "src", "server", "frame-handlers.ts"],
		]) {
			expect(readRepoFile(...rel)).not.toContain('from "./wire"');
			expect(readRepoFile(...rel)).not.toContain('commands/wire"');
		}
	});
});
