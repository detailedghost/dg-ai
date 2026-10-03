import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "../src/cli/index";
import { workspaceDirForProfile } from "../src/workspace/profile";

type Runtime = NonNullable<Parameters<typeof main>[1]>;
async function run(args: string[], runtime: Runtime = {}) {
	const output: string[] = [];
	const log = console.log;
	console.log = (...values: unknown[]) =>
		output.push(values.map(String).join(" "));
	try {
		await main(args, runtime);
		return output.join("\n");
	} finally {
		console.log = log;
	}
}

async function fixture(root: string) {
	const path = join(root, "messages.json");
	await Bun.write(
		path,
		JSON.stringify({
			folders: [
				{ id: "inbox", name: "Inbox", type: "system", aliases: ["inbox"] },
			],
			filters: [],
			messages: [],
		}),
	);
	return path;
}

describe("main inbox runtime", () => {
	test("refuses an explicitly missing DB profile before contacting a mailbox", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-missing-profile-"));
		const names: string[] = [];
		const browserCalls: string[] = [];
		try {
			await expect(
				run(
					["load", "folders", "--account-profile", "missing", "--dir", root],
					{
						profileGet: async (name) => {
							names.push(name);
							return null;
						},
						browserRequest: async (request) => {
							browserCalls.push(request.operation);
							return {};
						},
					},
				),
			).rejects.toThrow(/profile.*not found.*profile set/i);
			expect(names).toEqual(["missing"]);
			expect(browserCalls).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("dispatches Outlook filter confirmation rules from the effective DB profile", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-dispatch-"));
		try {
			await expect(
				run(
					[
						"filters",
						"apply",
						"--dry-run",
						"--account-profile",
						"work",
						"--dir",
						root,
					],
					{
						profileGet: async () => ({
							provider: "outlook",
							outlook: { clientId: "synthetic-client" },
						}),
					},
				),
			).rejects.toThrow(/filters apply.*requires --confirm/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("keeps account addresses out of public initialization output", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-init-privacy-"));
		try {
			const username = "private-account@example.test";
			const output = await run([
				"init",
				"--provider",
				"gmail",
				"--dir",
				root,
				"--username",
				username,
				"--config",
				await (async () => {
					const path = join(root, "config.json");
					await Bun.write(
						path,
						JSON.stringify({ configHome: join(root, "config") }),
					);
					return path;
				})(),
			]);
			expect(JSON.parse(output)).toMatchObject({
				kind: "workspace-init",
				provider: "gmail",
			});
			expect(output).not.toContain(username);
			expect(await Bun.file(join(root, "login.json")).exists()).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("loads the DB provider profile before explicit provider overrides", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-profile-"));
		const names: string[] = [];
		const runtime: Runtime = {
			profileGet: async (name) => {
				names.push(name);
				return {
					provider: "outlook",
					outlook: {
						clientId: "synthetic-client",
						tenantId: "organizations",
						authMode: "silent",
						pageSize: 2,
						scopes: ["Mail.Read"],
					},
				};
			},
			browserRequest: async () => {
				throw new Error("Fixture must not request browser access");
			},
			authCacheGet: async () => {
				throw new Error("Fixture must not load an auth cache");
			},
		};
		try {
			const dataPath = await fixture(root);
			const args = [
				"load",
				"folders",
				"--account-profile",
				"work",
				"--dir",
				join(root, "workspace"),
				"--data-path",
				dataPath,
			];
			expect(JSON.parse(await run(args, runtime))).toMatchObject({
				provider: "outlook",
				count: 1,
			});
			expect(
				JSON.parse(await run([...args, "--provider", "gmail"], runtime)),
			).toMatchObject({ provider: "gmail", count: 1 });
			expect(names).toEqual(["work", "work"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("feeds Proton extension metadata directly into redacted model-facing probe output", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-browser-"));
		const operations: string[] = [];
		const rawAddress = "private-sender@example.test";
		const runtime: Runtime = {
			profileGet: async () => ({
				provider: "protonmail",
				tabId: 7,
				accountHint: "private-account@example.test",
			}),
			browserRequest: async (request) => {
				operations.push(request.operation);
				expect(request.tabId).toBe(7);
				if (request.operation === "list-folders")
					return {
						folders: [
							{
								id: "inbox",
								name: "Inbox",
								type: "system",
								aliases: ["inbox"],
							},
						],
					};
				expect(request.operation).toBe("list-messages");
				return {
					messages: [
						{
							id: "private-message-id",
							from: rawAddress,
							subject: `Reply to ${rawAddress}`,
							snippet: "Call 555-111-2222",
							folderId: "inbox",
						},
					],
					hasMore: false,
				};
			},
		};
		try {
			const args = ["--account-profile", "personal", "--dir", root];
			expect(
				JSON.parse(await run(["load", "folders", ...args], runtime)).count,
			).toBe(1);
			const output = await run(
				["probe", "--folder", "inbox", "--limit", "1", ...args],
				runtime,
			);
			expect(JSON.parse(output)).toMatchObject({
				kind: "workspace-probe",
				fetched: 1,
				dryRun: true,
				mutated: false,
			});
			expect(operations).toContain("list-messages");
			expect(output).not.toContain(rawAddress);
			expect(output).not.toContain("private-account@example.test");
			expect(output).not.toContain("555-111-2222");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("explicit fixture data works when daemon, extension and auth hooks are unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-offline-"));
		try {
			const dataPath = await fixture(root);
			for (const provider of ["protonmail", "gmail", "outlook"]) {
				const output = await run(
					[
						"load",
						"folders",
						"--provider",
						provider,
						"--dir",
						join(root, provider),
						"--data-path",
						dataPath,
					],
					{
						profileGet: async () => {
							throw new Error("daemon unavailable");
						},
						browserRequest: async () => {
							throw new Error("extension unavailable");
						},
						authCacheGet: async () => {
							throw new Error("auth unavailable");
						},
					},
				);
				expect(JSON.parse(output)).toMatchObject({ provider, count: 1 });
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("workspaceDirForProfile installed default", () => {
	test("uses the same DG_HOME workspace from unrelated working directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-cwd-"));
		const originalCwd = process.cwd();
		const originalHome = process.env.DG_HOME;
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		await Promise.all([mkdir(firstCwd), mkdir(secondCwd)]);
		try {
			process.env.DG_HOME = join(root, "installed");
			process.chdir(firstCwd);
			const first = workspaceDirForProfile({
				provider: "gmail",
				accountProfile: "personal",
			});
			process.chdir(secondCwd);
			const second = workspaceDirForProfile({
				provider: "gmail",
				accountProfile: "personal",
			});
			expect(first).toBe(second);
			expect(resolve(first)).toBe(first);
			expect(first.startsWith(`${process.env.DG_HOME}/inbox/`)).toBe(true);
		} finally {
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.DG_HOME;
			else process.env.DG_HOME = originalHome;
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("main model-facing mailbox metadata", () => {
	test("redacts folder addresses in full output and classification guides while preserving private routing identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-folder-privacy-"));
		const sourceName = "private-source@example.test";
		const targetName = "private-target@example.test";
		try {
			for (const provider of ["protonmail", "gmail", "outlook"]) {
				const workspace = join(root, provider);
				const dataPath = join(root, provider + ".json");
				await Bun.write(
					dataPath,
					JSON.stringify({
						folders: [
							{
								id: "inbox",
								name: sourceName,
								path: sourceName,
								type: "folder",
							},
							{
								id: "receipts",
								name: targetName,
								path: targetName,
								type: "folder",
							},
						],
						filters: [],
						labels: [],
						messages: [
							{
								id: "private-source-message",
								from: "sender@domain.test",
								subject: "Receipt",
								snippet: "Safe preview",
								folderId: "inbox",
								folderName: sourceName,
							},
						],
					}),
				);
				const args = [
					"--provider",
					provider,
					"--data-path",
					dataPath,
					"--dir",
					workspace,
					"--ai-redacted",
					"false",
				];
				await run(["load", "folders", ...args]);
				await run(["batch", "--folder", "inbox", ...args]);
				await run(["classify-doc", ...args]);
				const snapshot = await Bun.file(join(workspace, "folders.json")).json();
				expect(
					snapshot.folders.find((row: { id: string }) => row.id === "inbox")
						.name,
				).toBe(sourceName);
				for (const command of [
					["folders", "inventory"],
					["status", "--full"],
					["sample"],
					["probe", "--folder", "inbox"],
					["analyze", "--by", "folder"],
				]) {
					const output = await run([...command, ...args]);
					expect(output).not.toContain(sourceName);
					expect(output).not.toContain(targetName);
				}
				const guide = await Bun.file(
					join(workspace, "classification.json"),
				).text();
				expect(guide).not.toContain(sourceName);
				expect(guide).not.toContain(targetName);
				expect(
					JSON.parse(guide).folders.map((row: { id: string }) => row.id),
				).toEqual(["inbox", "receipts"]);
				if (provider === "protonmail") {
					expect(
						await run([
							"decide",
							"--action",
							"move",
							"--target-folder",
							"receipts",
							...args,
						]),
					).not.toContain(targetName);
					await run(["apply", "--dry-run", ...args]);
					await run(["apply", "--confirm", ...args]);
					const dataset = await Bun.file(dataPath).json();
					expect(dataset.messages[0]).toMatchObject({
						folderId: "receipts",
						folderName: targetName,
					});
					const status = await Bun.file(
						join(workspace, "messages", "_status.json"),
					).json();
					const item = await Bun.file(
						join(workspace, status.items[0].file),
					).json();
					expect(item.sourceMessageId).toBe("private-source-message");
					expect(JSON.stringify(item.packet)).not.toContain(targetName);
					expect(await run(["status", "--full", ...args])).not.toContain(
						targetName,
					);
					expect(await run(["sample", ...args])).not.toContain(targetName);
				}
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
