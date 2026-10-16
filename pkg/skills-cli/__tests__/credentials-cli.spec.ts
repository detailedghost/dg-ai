import { describe, expect, test } from "bun:test";
import type {
	CredentialGrantSummary,
	CredentialMeta,
	CredentialSummary,
} from "@dg/common";
import { Command } from "commander";
import {
	type CredentialsDeps,
	registerCredentials,
} from "../src/commands/credentials";
import {
	inboxCliHarness,
	inboxDaemonFixture,
	skillsEntry,
} from "./inbox-cli-harness";
import { mergeEnv } from "./module-call";

const secret = "fixture-cli-credential-value-3c9e7d";

function fakeCli(
	options: {
		list?: CredentialSummary[];
		grants?: CredentialGrantSummary[];
		now?: string;
		value?: string;
	} = {},
) {
	const lines: string[] = [];
	const calls: { op: string; args: unknown[] }[] = [];
	let closed = 0;
	const deps: CredentialsDeps = {
		createClient: (session) => {
			calls.push({ op: "connect", args: [session] });
			return {
				set: async (name: string, value: string, meta?: CredentialMeta) => {
					calls.push({ op: "set", args: [name, value, meta] });
				},
				list: async () => options.list ?? [],
				delete: async (name: string) => {
					calls.push({ op: "delete", args: [name] });
					return true;
				},
				grant: async (prefix: string) => {
					calls.push({ op: "grant", args: [prefix] });
					return { prefix, path: `/fixture/grants/${prefix}.token` };
				},
				revoke: async (prefix: string) => {
					calls.push({ op: "revoke", args: [prefix] });
					return true;
				},
				listGrants: async () => options.grants ?? [],
				close: () => {
					closed++;
				},
			};
		},
		readValue: async () => options.value ?? secret,
		write: (line) => lines.push(line),
		now: () => new Date(options.now ?? "2026-06-01T00:00:00.000Z"),
	};
	const run = (args: string[]) => {
		const program = new Command().exitOverride().enablePositionalOptions();
		program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
		registerCredentials(program, deps);
		return program.parseAsync(["credentials", ...args], { from: "user" });
	};
	return { run, lines, calls, closed: () => closed };
}

describe("dg-skills credentials", () => {
	test("list shows metadata and flags expired and soon-to-expire entries", async () => {
		const cli = fakeCli({
			list: [
				{
					name: "consumer/expired",
					meta: { provider: "example", expiresAt: "2026-05-01T00:00:00Z" },
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
				{
					name: "consumer/expiring",
					meta: { site: "eu", expiresAt: "2026-06-10T00:00:00Z" },
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
				{
					name: "consumer/fresh",
					meta: { expiresAt: "2027-01-01T00:00:00Z", note: "kept out" },
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
				{
					name: "consumer/forever",
					meta: {},
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		await cli.run(["list"]);
		const output = JSON.parse(cli.lines[0]);
		expect(output.kind).toBe("credentials");
		expect(output.grants).toEqual([]);
		expect(output.credentials).toEqual([
			{
				name: "consumer/expired",
				provider: "example",
				expiresAt: "2026-05-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				expiry: "expired",
			},
			{
				name: "consumer/expiring",
				site: "eu",
				expiresAt: "2026-06-10T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				expiry: "expiring",
			},
			{
				name: "consumer/fresh",
				expiresAt: "2027-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
			{ name: "consumer/forever", updatedAt: "2026-01-01T00:00:00.000Z" },
		]);
		expect(cli.closed()).toBe(1);
	});

	test("set reads the value from the reader, passes meta and never prints the value", async () => {
		const cli = fakeCli();
		await cli.run([
			"--session",
			"fixture-session",
			"set",
			"consumer/example",
			"--meta",
			"provider=example",
			"--meta",
			"scopes=read,write",
		]);
		expect(cli.calls).toEqual([
			{ op: "connect", args: ["fixture-session"] },
			{
				op: "set",
				args: [
					"consumer/example",
					secret,
					{ provider: "example", scopes: ["read", "write"] },
				],
			},
		]);
		expect(cli.lines.join("\n")).not.toContain(secret);
		expect(JSON.parse(cli.lines[0])).toMatchObject({
			kind: "credential-saved",
			name: "consumer/example",
		});
	});

	test.each([
		[["--meta", "apiToken=x"]],
		[["--meta", "novalue"]],
		[["--meta", "note=a", "--meta", "note=b"]],
	])("set rejects bad meta %p before reading the value", async (meta) => {
		const cli = fakeCli();
		await expect(
			cli.run(["set", "consumer/example", ...meta]),
		).rejects.toThrow();
		expect(cli.calls).toEqual([]);
	});

	test("set rejects an invalid name before connecting", async () => {
		const cli = fakeCli();
		await expect(cli.run(["set", "Not Valid"])).rejects.toThrow(
			/credential name/,
		);
		expect(cli.calls).toEqual([]);
	});

	test("delete removes the named credential", async () => {
		const cli = fakeCli();
		await cli.run(["delete", "consumer/example"]);
		expect(cli.calls.at(-1)).toEqual({
			op: "delete",
			args: ["consumer/example"],
		});
		expect(JSON.parse(cli.lines[0])).toEqual({
			kind: "credential-deleted",
			name: "consumer/example",
			deleted: true,
		});
	});

	test("list shows grants without tokens", async () => {
		const grant = {
			prefix: "channel-review",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastUsedAt: null,
		};
		const cli = fakeCli({ grants: [grant] });
		await cli.run(["list"]);
		expect(JSON.parse(cli.lines[0]).grants).toEqual([grant]);
	});

	test("grant prints the token file path, never a token", async () => {
		const cli = fakeCli();
		await cli.run(["grant", "channel-review"]);
		expect(cli.calls.at(-1)).toEqual({ op: "grant", args: ["channel-review"] });
		expect(JSON.parse(cli.lines[0])).toEqual({
			kind: "credential-grant",
			prefix: "channel-review",
			path: "/fixture/grants/channel-review.token",
		});
	});

	test("revoke deletes the grant", async () => {
		const cli = fakeCli();
		await cli.run(["revoke", "channel-review"]);
		expect(JSON.parse(cli.lines[0])).toEqual({
			kind: "credential-grant-revoked",
			prefix: "channel-review",
			revoked: true,
		});
	});

	test.each([["Bad"], ["has/slash"]])(
		"grant rejects the invalid prefix %p before connecting",
		async (prefix) => {
			const cli = fakeCli();
			await expect(cli.run(["grant", prefix])).rejects.toThrow(/prefix/);
			expect(cli.calls).toEqual([]);
		},
	);

	test.each([["get"], ["show"], ["print"]])(
		"offers no %p command that could print a value",
		async (command) => {
			const cli = fakeCli();
			await expect(cli.run([command, "consumer/example"])).rejects.toThrow();
			expect(cli.lines).toEqual([]);
		},
	);

	test("the built entry reads piped stdin and keeps the value out of stdout and stderr", async () => {
		const h = inboxCliHarness();
		const daemon = inboxDaemonFixture(h, (request, reply) =>
			reply({
				type: "cli-credentials-result",
				sessionId: "fixture-cli-session",
				requestId: request.requestId,
				ok: true,
				value: null,
			}),
		);
		try {
			const proc = Bun.spawn(
				[
					process.execPath,
					skillsEntry,
					"credentials",
					"--session",
					daemon.sessionId,
					"set",
					"consumer/example",
					"--meta",
					"provider=example",
				],
				{
					cwd: h.cwd,
					env: mergeEnv({ DG_HOME: h.dgHome, DG_SESSION_TOKEN: undefined }),
					stdin: new Blob([`${secret}\n`]),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(code, stderr).toBe(0);
			expect(daemon.requests[0]).toMatchObject({
				type: "cli-credentials-request",
				operation: "set",
				name: "consumer/example",
				value: secret,
			});
			expect(stdout).not.toContain(secret);
			expect(stderr).not.toContain(secret);
		} finally {
			daemon.stop();
			h.cleanup();
		}
	});

	test("the built entry names the start command when dg-daemon is not running", async () => {
		const h = inboxCliHarness();
		try {
			const proc = Bun.spawn(
				[process.execPath, skillsEntry, "credentials", "list"],
				{
					cwd: h.cwd,
					env: mergeEnv({ DG_HOME: h.dgHome }),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stderr, code] = await Promise.all([
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(code).not.toBe(0);
			expect(stderr).toContain(
				"dg-daemon is not running; start it with dg-agent start",
			);
		} finally {
			h.cleanup();
		}
	});
});
