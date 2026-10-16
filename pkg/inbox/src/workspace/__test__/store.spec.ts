import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { MailFolder, MailMessageSummary } from "../../providers/types";
import {
	readMessageStatus,
	workspacePaths,
	writeMessageBatch,
	writeMessageBatchStream,
} from "../store";

const folders: MailFolder[] = [{ id: "inbox", name: "Inbox", type: "system" }];

function messagesFor(ids: string[]): MailMessageSummary[] {
	return ids.map((id) => ({
		id,
		from: `${id}@example.com`,
		subject: `Subject ${id}`,
		snippet: "snippet",
		folderId: "inbox",
		folderName: "Inbox",
		read: false,
	}));
}

function tmpDir(name: string): string {
	return `/tmp/email-organizer-tests-${crypto.randomUUID()}/${name}`;
}

describe("writeMessageBatch", () => {
	test("clears prior message work-items so a re-batch reflects only the current fetch", async () => {
		const paths = workspacePaths(tmpDir("batch-hygiene"));

		await writeMessageBatch({
			paths,
			folders,
			messages: messagesFor(["m1", "m2"]),
			snippetLength: 160,
		});
		const firstFiles = (await readdir(paths.messagesDir)).sort();
		expect(firstFiles).toHaveLength(3);
		expect(firstFiles).toContain("_status.json");
		expect((await readMessageStatus(paths)).total).toBe(2);

		await writeMessageBatch({
			paths,
			folders,
			messages: messagesFor(["m3"]),
			snippetLength: 160,
		});
		const secondFiles = (await readdir(paths.messagesDir)).sort();

		expect(secondFiles).toHaveLength(2);
		expect(
			secondFiles.some(
				(file) => firstFiles.includes(file) && file !== "_status.json",
			),
		).toBe(false);
		const status = await readMessageStatus(paths);
		expect(status.total).toBe(1);
		expect(status.items[0].fromDomain).toBe("example.com");
	});

	test("an empty re-batch leaves no stale message files behind", async () => {
		const paths = workspacePaths(tmpDir("batch-hygiene-empty"));

		await writeMessageBatch({
			paths,
			folders,
			messages: messagesFor(["m1"]),
			snippetLength: 160,
		});
		await writeMessageBatch({
			paths,
			folders,
			messages: [],
			snippetLength: 160,
		});

		expect(await readdir(paths.messagesDir)).toEqual(["_status.json"]);
		expect((await readMessageStatus(paths)).total).toBe(0);
	});

	test("a failed re-batch keeps the previous messages and decisions", async () => {
		const paths = workspacePaths(tmpDir("batch-keeps-decisions"));
		await writeMessageBatch({
			paths,
			folders,
			messages: messagesFor(["m1"]),
			snippetLength: 160,
		});
		const status = await readMessageStatus(paths);
		const file = join(paths.dir, status.items[0]!.file);
		const item = await Bun.file(file).json();
		item.decision = { action: "move", targetFolder: "Receipts", reason: "keep me" };
		await Bun.write(file, `${JSON.stringify(item, null, 2)}\n`);

		async function* fail(): AsyncGenerator<MailMessageSummary[]> {
			throw new Error("Open Proton Mail and sign in");
		}
		await expect(
			writeMessageBatchStream({
				paths,
				folders,
				pages: fail(),
				snippetLength: 160,
			}),
		).rejects.toThrow(/sign in/);

		const kept = await readMessageStatus(paths);
		expect(kept.total).toBe(1);
		expect(kept.items[0]?.fromDomain).toBe("example.com");
		expect((await Bun.file(file).json()).decision.reason).toBe("keep me");
		const leftovers = (await readdir(paths.dir)).filter((name) =>
			name.startsWith(".messages-"),
		);
		expect(leftovers).toEqual([]);
	});
});

async function* pagesOf(
	...pages: MailMessageSummary[][]
): AsyncGenerator<MailMessageSummary[]> {
	for (const page of pages) {
		yield page;
	}
}

describe("writeMessageBatchStream", () => {
	test("writes every streamed message across worker threads and redacts content", async () => {
		const paths = workspacePaths(tmpDir("batch-workers"));
		const messages = messagesFor(["a", "b", "c", "d", "e"]);
		messages[0].subject = "Ping alice@corp.example for report 1234567";

		// workerThreshold:0 + chunkSize:1 force the real Worker pool to fan the
		// messages across threads instead of the inline main-thread path.
		const status = await writeMessageBatchStream({
			paths,
			folders,
			pages: pagesOf(messages.slice(0, 3), messages.slice(3)),
			snippetLength: 160,
			provider: "outlook",
			workers: 2,
			workerThreshold: 0,
			chunkSize: 1,
		});

		expect(status.total).toBe(5);
		expect(status.provider).toBe("outlook");
		const files = (await readdir(paths.messagesDir)).filter(
			(file) => file !== "_status.json",
		);
		expect(files).toHaveLength(5);

		const reloaded = await readMessageStatus(paths);
		expect(reloaded.total).toBe(5);
		const redacted = reloaded.items.find((item) =>
			item.subject.startsWith("Ping"),
		);
		expect(redacted?.subject).toContain("[email:corp.example]");
		expect(redacted?.subject).not.toContain("alice@");
	});

	test("worker and inline paths produce identical work-item files", async () => {
		const messages = messagesFor(["p1", "p2", "p3", "p4"]);
		messages[1].subject = "Call 800-555-1212 about foo@bar.example";
		const inlinePaths = workspacePaths(tmpDir("batch-parity-inline"));
		const workerPaths = workspacePaths(tmpDir("batch-parity-worker"));

		await writeMessageBatchStream({
			paths: inlinePaths,
			folders,
			pages: pagesOf(messages),
			snippetLength: 160,
			workers: 1,
		});
		await writeMessageBatchStream({
			paths: workerPaths,
			folders,
			pages: pagesOf(messages),
			snippetLength: 160,
			workers: 3,
			workerThreshold: 0,
			chunkSize: 1,
		});

		const inlineFiles = (await readdir(inlinePaths.messagesDir))
			.filter((file) => file !== "_status.json")
			.sort();
		const workerFiles = (await readdir(workerPaths.messagesDir))
			.filter((file) => file !== "_status.json")
			.sort();
		expect(workerFiles).toEqual(inlineFiles);

		for (const file of inlineFiles) {
			// statusUpdatedAt is a per-run timestamp; everything else (packet,
			// redaction, ids) must be byte-identical between the two code paths.
			const inlineItem = normalizeTimestamp(
				await Bun.file(join(inlinePaths.messagesDir, file)).json(),
			);
			const workerItem = normalizeTimestamp(
				await Bun.file(join(workerPaths.messagesDir, file)).json(),
			);
			expect(workerItem).toEqual(inlineItem);
		}
	});
});

function normalizeTimestamp(
	item: Record<string, unknown>,
): Record<string, unknown> {
	return { ...item, statusUpdatedAt: "<ts>" };
}
