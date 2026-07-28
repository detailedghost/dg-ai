import { describe, expect, it } from "bun:test";
import {
	MAILBOX_CORE_GATE_COMMANDS,
	runMailboxCoreGate,
} from "../scripts/mailbox-core-gate";
import type { MailboxContractManifest } from "../scripts/check-mailbox-boundaries";

const manifest = {
	schemaVersion: 1,
	contract: "mailbox-provider-v1",
	version: 1,
	protectedPaths: ["core.ts"],
	protectedDirectories: [],
	adapterRoots: ["adapters"],
	excludedPathSegments: ["__tests__", "fixtures", "generated"],
	forbiddenModulePrefixes: ["@azure/msal"],
	forbiddenProviderUrlFragments: ["graph.microsoft.com"],
	normalization: {
		encoding: "utf8",
		lineEndings: "lf",
		stripUtf8Bom: true,
		pathOrdering: "ascii-posix-bytewise",
		entryFraming:
			"domain-null-schema-null-version-null-count-null-path-length-null-path-null-content-length-null-content",
	},
	hash: {
		algorithm: "sha256",
		digest: "a".repeat(64),
	},
	successRecord: {
		format: "canonical-json",
		fields: ["contract", "hash", "status", "version"],
		status: "passed",
	},
} satisfies MailboxContractManifest;

function harness(failAt?: string) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const calls: string[] = [];
	return {
		calls,
		stderr,
		stdout,
		deps: {
			repoRoot: "/repo",
			extensionRoot: "/repo/pkg/extension",
			async run(command: (typeof MAILBOX_CORE_GATE_COMMANDS)[number]) {
				calls.push(command.name);
				return {
					exitCode: command.name === failAt ? 1 : 0,
					stdout: `${command.name}:out\n`,
					stderr: `${command.name}:err\n`,
				};
			},
			writeStdout(value: string) {
				stdout.push(value);
			},
			writeStderr(value: string) {
				stderr.push(value);
			},
			async loadManifest() {
				return manifest;
			},
			async checkBoundaries() {
				calls.push("boundaries");
				if (failAt === "boundaries") {
					throw new Error("boundary failure");
				}
				return manifest;
			},
		},
	};
}

describe("mailbox core gate", () => {
	it("emits exactly one canonical success record after every gate passes", async () => {
		const test = harness();
		await runMailboxCoreGate(test.deps);

		expect(test.calls).toEqual([
			"tests",
			"boundaries",
			"typecheck",
			"chrome",
			"firefox",
		]);
		expect(test.stdout).toEqual([
			`{"contract":"mailbox-provider-v1","hash":"${"a".repeat(64)}","status":"passed","version":1}\n`,
		]);
		expect(test.stderr.join("")).toContain("tests:out");
		expect(test.stderr.join("")).toContain("firefox:err");
	});

	it("emits no success record and stops at every failing phase", async () => {
		for (const phase of [
			"tests",
			"boundaries",
			"typecheck",
			"chrome",
			"firefox",
		]) {
			const test = harness(phase);
			await expect(runMailboxCoreGate(test.deps)).rejects.toThrow();
			expect(test.stdout).toEqual([]);
			expect(test.calls.at(-1)).toBe(phase);
		}
	});
});
