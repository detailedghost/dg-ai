import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli/index";
import { FileMailAccessClient } from "../src/mail/file-client";
import { hashId } from "../src/privacy/hash";
import type { InboxRuntime } from "../src/runtime";
import { fixturePath } from "./fixture-paths";

type RunResult = { stdout: string; exitCode: number };

async function run(args: string[], runtime: InboxRuntime = {}): Promise<RunResult> {
	const output: string[] = [];
	const log = console.log;
	console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
	const originalExitCode = process.exitCode;
	process.exitCode = 0;
	try {
		await main(args, runtime);
		return { stdout: output.join("\n"), exitCode: process.exitCode ?? 0 };
	} finally {
		console.log = log;
		process.exitCode = originalExitCode ?? 0;
	}
}

async function withFixtureWorkspace(
	run_: (dir: string, dataPath: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "dg-inbox-mail-send-"));
	const dataPath = join(dir, "mail-dataset.json");
	try {
		await Bun.write(dataPath, await Bun.file(fixturePath("mail-dataset.json")).text());
		await run_(dir, dataPath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function baseArgs(dir: string, dataPath: string): string[] {
	return ["--provider", "outlook", "--data-path", dataPath, "--dir", dir];
}

async function rememberDraftId(dir: string, dataPath: string): Promise<string> {
	await run(["mail", "list", "--folder", "drafts", ...baseArgs(dir, dataPath)]);
	return hashId("msg-draft-1");
}

async function draftFolder(dir: string, dataPath: string, draftId: string): Promise<string> {
	const sent = await run(["mail", "list", "--folder", "sent", ...baseArgs(dir, dataPath)]);
	const inSent = JSON.parse(sent.stdout).messages.some((m: { id: string }) => m.id === draftId);
	return inSent ? "sent" : "drafts";
}

async function auditRecords(dir: string): Promise<Record<string, unknown>[]> {
	try {
		const files = await readdir(join(dir, "audit"));
		return Promise.all(
			files.map(async (file) => Bun.file(join(dir, "audit", file)).json()),
		);
	} catch {
		return [];
	}
}

const originalSendDraft = FileMailAccessClient.prototype.sendDraft;

afterEach(() => {
	FileMailAccessClient.prototype.sendDraft = originalSendDraft;
});

describe("dg-skills inbox mail send — approval outcomes", () => {
	test("approved: sends, prints mail-sent, moves the draft to sent, and audits hashes only", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const draftId = await rememberDraftId(dir, dataPath);
			let seenApproval: unknown;
			const { stdout, exitCode } = await run(
				["mail", "send", "--draft", draftId, ...baseArgs(dir, dataPath)],
				{
					sendApproval: async (approval) => {
						seenApproval = approval;
						return { approved: true, decidedAt: "2026-10-23T00:00:00.000Z" };
					},
				},
			);
			const output = JSON.parse(stdout);
			expect(output).toEqual({
				kind: "mail-sent",
				draftId,
				approval: { by: "extension", decidedAt: "2026-10-23T00:00:00.000Z" },
			});
			expect(exitCode).toBe(0);
			expect(await draftFolder(dir, dataPath, draftId)).toBe("sent");

			expect(seenApproval).toMatchObject({
				provider: "outlook",
				profile: "default",
				draftId,
				to: ["vendor@example.test"],
				cc: [],
				subject: "Draft: follow-up",
				text: "Following up on our last conversation.",
				attachments: [],
			});
			expect((seenApproval as { contentHash: string }).contentHash).toMatch(/^[0-9a-f]{64}$/);

			const records = await auditRecords(dir);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				contentHash: (seenApproval as { contentHash: string }).contentHash,
				approvedAt: "2026-10-23T00:00:00.000Z",
				provider: "outlook",
				sent: true,
			});
			const auditText = JSON.stringify(records[0]);
			expect(auditText).not.toContain("vendor@example.test");
			expect(auditText).not.toContain("Draft: follow-up");
			expect(auditText).not.toContain("Following up");
		});
	});

	test("rejected: prints mail-send-rejected, exits 1, and leaves the draft in drafts", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const draftId = await rememberDraftId(dir, dataPath);
			const { stdout, exitCode } = await run(
				["mail", "send", "--draft", draftId, ...baseArgs(dir, dataPath)],
				{
					sendApproval: async () => ({
						approved: false,
						decidedAt: "2026-10-23T00:05:00.000Z",
					}),
				},
			);
			expect(JSON.parse(stdout)).toEqual({
				kind: "mail-send-rejected",
				draftId,
				decidedAt: "2026-10-23T00:05:00.000Z",
			});
			expect(exitCode).toBe(1);
			expect(await draftFolder(dir, dataPath, draftId)).toBe("drafts");
		});
	});

	test("timeout: prints mail-send-timeout with waitedSeconds and exits 1", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const draftId = await rememberDraftId(dir, dataPath);
			const { stdout, exitCode } = await run(
				["mail", "send", "--draft", draftId, "--wait", "45", ...baseArgs(dir, dataPath)],
				{
					sendApproval: async () => {
						throw new Error(
							"Send approval timed out; the human did not decide within the wait.",
						);
					},
				},
			);
			expect(JSON.parse(stdout)).toEqual({
				kind: "mail-send-timeout",
				draftId,
				waitedSeconds: 45,
			});
			expect(exitCode).toBe(1);
			expect(await draftFolder(dir, dataPath, draftId)).toBe("drafts");
		});
	});

	test("draft-changed: aborts with mail-send-aborted and never calls sendDraft", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const draftId = await rememberDraftId(dir, dataPath);
			const sendDraft = spyOn(FileMailAccessClient.prototype, "sendDraft");
			const { stdout, exitCode } = await run(
				["mail", "send", "--draft", draftId, ...baseArgs(dir, dataPath)],
				{
					sendApproval: async () => {
						const mutable = await new FileMailAccessClient({ dataPath }).getDraft(
							"msg-draft-1",
						);
						mutable.subject = "Changed after approval";
						return { approved: true, decidedAt: "2026-10-23T00:10:00.000Z" };
					},
				},
			);
			expect(JSON.parse(stdout)).toEqual({
				kind: "mail-send-aborted",
				reason: "draft-changed",
			});
			expect(exitCode).toBe(1);
			expect(sendDraft).not.toHaveBeenCalled();
			expect(await draftFolder(dir, dataPath, draftId)).toBe("drafts");
		});
	});

	test("send failure after approval prints mail-send-failed and audits sent:false", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const draftId = await rememberDraftId(dir, dataPath);
			FileMailAccessClient.prototype.sendDraft = async () => {
				throw new Error("fixture send failure");
			};
			const { stdout, exitCode } = await run(
				["mail", "send", "--draft", draftId, ...baseArgs(dir, dataPath)],
				{
					sendApproval: async () => ({
						approved: true,
						decidedAt: "2026-10-23T00:15:00.000Z",
					}),
				},
			);
			expect(JSON.parse(stdout)).toEqual({
				kind: "mail-send-failed",
				draftId,
				approval: { by: "extension", decidedAt: "2026-10-23T00:15:00.000Z" },
			});
			expect(exitCode).toBe(1);
			const records = await auditRecords(dir);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ sent: false, provider: "outlook" });
		});
	});

	test("a non-timeout daemon error during approval propagates without sending", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const draftId = await rememberDraftId(dir, dataPath);
			const sendDraft = spyOn(FileMailAccessClient.prototype, "sendDraft");
			await expect(
				run(["mail", "send", "--draft", draftId, ...baseArgs(dir, dataPath)], {
					sendApproval: async () => {
						throw new Error("Inbox daemon request failed. Check the session and retry.");
					},
				}),
			).rejects.toThrow(/Inbox daemon request failed/);
			expect(sendDraft).not.toHaveBeenCalled();
			expect(await draftFolder(dir, dataPath, draftId)).toBe("drafts");
		});
	});

	test("--wait 601 exits 1 before any approval round trip", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const draftId = await rememberDraftId(dir, dataPath);
			let called = false;
			await expect(
				run(
					["mail", "send", "--draft", draftId, "--wait", "601", ...baseArgs(dir, dataPath)],
					{
						sendApproval: async () => {
							called = true;
							return { approved: true, decidedAt: "2026-10-23T00:20:00.000Z" };
						},
					},
				),
			).rejects.toThrow(/--wait must be between 1 and 600/);
			expect(called).toBe(false);
		});
	});
});
