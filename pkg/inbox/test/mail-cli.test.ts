import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli/index";
import { defaultConfig } from "../src/config/defaults";
import { createMailAccessClient } from "../src/mail/factory";
import { hashId } from "../src/privacy/hash";
import type { InboxRuntime } from "../src/runtime";
import { fixturePath } from "./fixture-paths";

type Runtime = InboxRuntime;
type RunResult = { stdout: string; exitCode: number | undefined };

async function run(args: string[], runtime: Runtime = {}): Promise<RunResult> {
	const output: string[] = [];
	const log = console.log;
	console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
	const originalExitCode = process.exitCode;
	process.exitCode = undefined;
	try {
		await main(args, runtime);
		return { stdout: output.join("\n"), exitCode: process.exitCode };
	} finally {
		console.log = log;
		process.exitCode = originalExitCode;
	}
}

async function withFixtureWorkspace(
	run_: (dir: string, dataPath: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "dg-inbox-mail-cli-"));
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

describe("dg-skills inbox mail list", () => {
	test("prints the documented shape with redacted, hashed ids and a 120-character snippet cap", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const { stdout } = await run(["mail", "list", ...baseArgs(dir, dataPath)]);
			const output = JSON.parse(stdout);
			expect(output).toMatchObject({
				kind: "mail-list",
				provider: "outlook",
				folder: { id: "inbox", name: "Inbox" },
				page: 0,
				limit: 20,
				count: 5,
				hasMore: false,
			});
			expect(output.messages).toHaveLength(5);
			for (const message of output.messages) {
				expect(message.id).toMatch(/^m_hash_[0-9a-f]{12}$/);
				expect(message.snippet.length).toBeLessThanOrEqual(120);
				expect(JSON.stringify(message)).not.toContain("@");
			}
		});
	});

	test("--unread narrows to the two unread inbox messages", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const { stdout } = await run([
				"mail",
				"list",
				"--unread",
				...baseArgs(dir, dataPath),
			]);
			expect(JSON.parse(stdout).count).toBe(2);
		});
	});

	test("--from narrows to the example.test domain senders in the inbox", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const { stdout } = await run([
				"mail",
				"list",
				"--from",
				"example.test",
				...baseArgs(dir, dataPath),
			]);
			expect(JSON.parse(stdout).count).toBe(3);
		});
	});

	test("--subject narrows to the one invoice message", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const { stdout } = await run([
				"mail",
				"list",
				"--subject",
				"invoice",
				...baseArgs(dir, dataPath),
			]);
			expect(JSON.parse(stdout).count).toBe(1);
		});
	});

	test("--since with an exact ISO date narrows to messages on or after it", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const { stdout } = await run([
				"mail",
				"list",
				"--since",
				"2026-10-16",
				...baseArgs(dir, dataPath),
			]);
			expect(JSON.parse(stdout).count).toBe(3);
		});
	});

	test("--since 7d narrows against the real clock, computed the same way the test checks it", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const dataset = (await Bun.file(dataPath).json()) as {
				messages: { folderId: string; receivedAt: string }[];
			};
			const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
			const expectedCount = dataset.messages.filter(
				(message) =>
					message.folderId === "inbox" &&
					new Date(message.receivedAt).getTime() >= cutoffMs,
			).length;
			const { stdout } = await run([
				"mail",
				"list",
				"--since",
				"7d",
				...baseArgs(dir, dataPath),
			]);
			expect(JSON.parse(stdout).count).toBe(expectedCount);
		});
	});

	test("--folder drafts lists the fixture draft", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const { stdout } = await run([
				"mail",
				"list",
				"--folder",
				"drafts",
				...baseArgs(dir, dataPath),
			]);
			const output = JSON.parse(stdout);
			expect(output.count).toBe(1);
			expect(output.messages[0].id).toBe(hashId("msg-draft-1"));
		});
	});
});

describe("dg-skills inbox mail search", () => {
	test("echoes the redacted query and returns the matching message", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const { stdout } = await run([
				"mail",
				"search",
				"--query",
				"checklist",
				...baseArgs(dir, dataPath),
			]);
			const output = JSON.parse(stdout);
			expect(output.kind).toBe("mail-search");
			expect(output.query).toBe("checklist");
			expect(output.count).toBe(1);
		});
	});

	test("rejects a missing --query", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			await expect(run(["mail", "search", ...baseArgs(dir, dataPath)])).rejects.toThrow(
				/mail search requires --query TEXT/,
			);
		});
	});
});

describe("dg-skills inbox mail read", () => {
	test("strips an Outlook-style quoted reply and reports quotedHistoryRemoved:true", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const id = hashId("msg-quoted-outlook-1");
			await run(["mail", "list", ...baseArgs(dir, dataPath)]);
			const { stdout } = await run([
				"mail",
				"read",
				"--message",
				id,
				...baseArgs(dir, dataPath),
			]);
			const output = JSON.parse(stdout);
			expect(output.quotedHistoryRemoved).toBe(true);
			expect(output.text).toBe("Sounds good, approved.");
			expect(output.text).not.toContain("Original Message");
		});
	});

	test("strips an 'On ... wrote:' quoted reply and reports quotedHistoryRemoved:true", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const id = hashId("msg-quoted-wrote-1");
			await run(["mail", "list", ...baseArgs(dir, dataPath)]);
			const { stdout } = await run([
				"mail",
				"read",
				"--message",
				id,
				...baseArgs(dir, dataPath),
			]);
			const output = JSON.parse(stdout);
			expect(output.quotedHistoryRemoved).toBe(true);
			expect(output.text).toBe("Yes, the checklist looks complete.");
			expect(output.text).not.toContain("wrote:");
		});
	});

	test("--full-quotes keeps the quoted block and reports quotedHistoryRemoved:false", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const id = hashId("msg-quoted-outlook-1");
			await run(["mail", "list", ...baseArgs(dir, dataPath)]);
			const { stdout } = await run([
				"mail",
				"read",
				"--message",
				id,
				"--full-quotes",
				...baseArgs(dir, dataPath),
			]);
			const output = JSON.parse(stdout);
			expect(output.quotedHistoryRemoved).toBe(false);
			expect(output.text).toContain("Original Message");
		});
	});

	test("the HTML-only message returns text with no tags and no entities", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const id = hashId("msg-html-1");
			await run(["mail", "list", ...baseArgs(dir, dataPath)]);
			const { stdout } = await run([
				"mail",
				"read",
				"--message",
				id,
				...baseArgs(dir, dataPath),
			]);
			const output = JSON.parse(stdout);
			expect(output.text).not.toContain("<");
			expect(output.text).not.toContain("&");
			expect(output.text).toContain("Faster search");
			expect(output.text).toContain("Dark mode");
		});
	});

	test("respects --max-chars and reports truncated:true", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const id = hashId("msg-plain-1");
			await run(["mail", "list", ...baseArgs(dir, dataPath)]);
			const { stdout } = await run([
				"mail",
				"read",
				"--message",
				id,
				"--max-chars",
				"10",
				...baseArgs(dir, dataPath),
			]);
			const output = JSON.parse(stdout);
			expect(output.text.length).toBe(10);
			expect(output.truncated).toBe(true);
		});
	});
});

describe("dg-skills inbox mail attachments", () => {
	test("lists attachment metadata with no contentBytes field", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const id = hashId("msg-attachments-1");
			await run(["mail", "list", ...baseArgs(dir, dataPath)]);
			const { stdout } = await run([
				"mail",
				"attachments",
				"--message",
				id,
				...baseArgs(dir, dataPath),
			]);
			const output = JSON.parse(stdout);
			expect(output.kind).toBe("mail-attachments");
			expect(output.messageId).toBe(id);
			expect(output.attachments).toHaveLength(3);
			for (const attachment of output.attachments) {
				expect(attachment).not.toHaveProperty("contentBytes");
			}
			expect(output.attachments.some((a: { isInline: boolean }) => a.isInline)).toBe(
				true,
			);
		});
	});
});

describe("dg-skills inbox mail draft", () => {
	test("new reads the body from --body-file and prints the draft shape", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const bodyFile = join(dir, "body.txt");
			await Bun.write(bodyFile, "See the attached numbers.");
			const { stdout } = await run([
				"mail",
				"draft",
				"new",
				"--to",
				"a@example.test",
				"--subject",
				"S",
				"--body-file",
				bodyFile,
				...baseArgs(dir, dataPath),
			]);
			const output = JSON.parse(stdout);
			expect(output).toMatchObject({
				kind: "mail-draft",
				provider: "outlook",
				folder: "Drafts",
				subject: "S",
			});
			expect(output.to).toEqual(["[email:example.test]"]);
			expect(output.id).toMatch(/^m_hash_[0-9a-f]{12}$/);
		});
	});

	test("new rejects a missing --body-file", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			await expect(
				run([
					"mail",
					"draft",
					"new",
					"--to",
					"a@example.test",
					"--subject",
					"S",
					...baseArgs(dir, dataPath),
				]),
			).rejects.toThrow(/draft body must come from --body-file PATH or --body-file -/);
		});
	});

	test("reply prints the same shape with inReplyTo set to the original hashed id", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const id = hashId("msg-quoted-outlook-1");
			await run(["mail", "list", ...baseArgs(dir, dataPath)]);
			const bodyFile = join(dir, "reply.txt");
			await Bun.write(bodyFile, "Thanks, confirmed.");
			const { stdout } = await run([
				"mail",
				"draft",
				"reply",
				"--message",
				id,
				"--body-file",
				bodyFile,
				"--reply-all",
				"--cc",
				"extra@other.test",
				...baseArgs(dir, dataPath),
			]);
			const output = JSON.parse(stdout);
			expect(output.kind).toBe("mail-draft");
			expect(output.inReplyTo).toBe(id);
			expect(output.cc).toEqual(["[email:example.test]", "[email:other.test]"]);
		});
	});
});

describe("dg-skills inbox mail send — fixture refusal", () => {
	test("refuses without a sendApproval hook, printing mail-send-refused and exiting 1", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const id = hashId("msg-draft-1");
			await run(["mail", "list", "--folder", "drafts", ...baseArgs(dir, dataPath)]);
			const { stdout, exitCode } = await run([
				"mail",
				"send",
				"--draft",
				id,
				...baseArgs(dir, dataPath),
			]);
			expect(JSON.parse(stdout)).toEqual({
				kind: "mail-send-refused",
				reason: "no-approval-channel",
			});
			expect(exitCode).toBe(1);
		});
	});

	test("leaves the fixture draft in drafts after a refusal", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const id = hashId("msg-draft-1");
			await run(["mail", "list", "--folder", "drafts", ...baseArgs(dir, dataPath)]);
			await run(["mail", "send", "--draft", id, ...baseArgs(dir, dataPath)]);
			const { stdout } = await run([
				"mail",
				"list",
				"--folder",
				"drafts",
				...baseArgs(dir, dataPath),
			]);
			expect(JSON.parse(stdout).messages.map((m: { id: string }) => m.id)).toContain(id);
		});
	});
});

describe("dg-skills inbox mail — error shapes", () => {
	test("an unknown message id is refused before any client call", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			await expect(
				run(["mail", "read", "--message", "m_hash_doesnotexist", ...baseArgs(dir, dataPath)]),
			).rejects.toThrow(/unknown message id; run mail list or mail search first/);
		});
	});

	test("gmail is refused with the exact unsupported-provider sentence", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			await expect(
				run(["mail", "list", "--provider", "gmail", "--data-path", dataPath, "--dir", dir]),
			).rejects.toThrow(
				/mail commands support outlook and protonmail; gmail is not supported in this release/,
			);
		});
	});

	test("--limit 201 is rejected", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			await expect(
				run(["mail", "list", "--limit", "201", ...baseArgs(dir, dataPath)]),
			).rejects.toThrow(/--limit must be between 1 and 200/);
		});
	});

	test("--wait 601 is rejected", async () => {
		await withFixtureWorkspace(async (dir, dataPath) => {
			const id = hashId("msg-draft-1");
			await run(["mail", "list", "--folder", "drafts", ...baseArgs(dir, dataPath)]);
			await expect(
				run(
					["mail", "send", "--draft", id, "--wait", "601", ...baseArgs(dir, dataPath)],
					{ sendApproval: async () => ({ approved: true, decidedAt: new Date().toISOString() }) },
				),
			).rejects.toThrow(/--wait must be between 1 and 600/);
		});
	});
});

describe("createMailAccessClient — provider stubs", () => {
	test("protonmail without a dataPath throws not implemented in this build", () => {
		const config = { ...defaultConfig, provider: "protonmail" as const, mail: { dataPath: undefined } };
		expect(() => createMailAccessClient(config, {})).toThrow("not implemented in this build");
	});

	test("outlook without a dataPath builds a Graph-backed client instead of the stub", () => {
		const config = { ...defaultConfig, provider: "outlook" as const, mail: { dataPath: undefined } };
		expect(() => createMailAccessClient(config, {})).not.toThrow();
	});

	test("gmail throws the unsupported-provider sentence even without a dataPath", () => {
		const config = { ...defaultConfig, provider: "gmail" as const, mail: { dataPath: undefined } };
		expect(() => createMailAccessClient(config, {})).toThrow(
			"mail commands support outlook and protonmail; gmail is not supported in this release",
		);
	});
});
