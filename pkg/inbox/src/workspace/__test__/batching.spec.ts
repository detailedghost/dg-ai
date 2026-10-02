import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriterPool } from "../writer-pool";
import { transformMessage } from "../message-transform";
import {
	readMessageStatus,
	workspacePaths,
	writeMessageBatchStream,
} from "../store";
import type { MailMessageSummary } from "../../providers/types";

function messages(count: number): MailMessageSummary[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `message-${index}`,
		from: "private@example.test",
		subject: `Subject ${index}`,
		snippet: "Private account 123456789",
		folderId: "inbox",
	}));
}

describe("createWriterPool", () => {
	test("bounds real writes by pool size while processing 3,007 messages", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-writer-pool-"));
		const rows = messages(3007);
		const size = 3;
		let active = 0;
		let maximum = 0;
		const originalWrite = Bun.write;
		const write = spyOn(Bun, "write").mockImplementation(
			async (target, data, options) => {
				maximum = Math.max(maximum, ++active);
				try {
					await new Promise((resolve) => setTimeout(resolve, 1));
					if (typeof target !== "string" || typeof data !== "string")
						throw new Error(
							"Fixture writes must use file paths and string data",
						);
					return await originalWrite(target, data);
				} finally {
					active -= 1;
				}
			},
		);
		const pool = createWriterPool(size, {
			folderNames: ["Inbox"],
			snippetLength: 160,
			nowIso: new Date().toISOString(),
			messagesDirAbs: root,
		});
		try {
			const entries = await pool.process(rows);
			expect(entries).toHaveLength(rows.length);
			expect(new Set(entries.map((entry) => entry.id)).size).toBe(rows.length);
			expect(maximum).toBeGreaterThan(0);
			expect(maximum).toBeLessThanOrEqual(size);
			expect(await readdir(root)).toHaveLength(rows.length);
		} finally {
			write.mockRestore();
			await pool.close();
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);
});

describe("writeMessageBatchStream large mailbox", () => {
	test("writes all unique redacted items from bounded provider pages", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-large-batch-"));
		const paths = workspacePaths(root);
		const rows = messages(3007);
		const pageSize = 37;
		let consumed = 0;
		async function* pages() {
			for (let offset = 0; offset < rows.length; offset += pageSize) {
				consumed += 1;
				yield rows.slice(offset, offset + pageSize);
			}
		}
		try {
			const status = await writeMessageBatchStream({
				paths,
				folders: [{ id: "inbox", name: "Inbox", type: "system" }],
				pages: pages(),
				snippetLength: 160,
				provider: "gmail",
				workers: 3,
				chunkSize: 17,
				workerThreshold: 0,
			});
			expect(consumed).toBe(Math.ceil(rows.length / pageSize));
			expect(status.total).toBe(rows.length);
			expect(
				(await readMessageStatus(paths)).items.map((item) => item.id).sort(),
			).toEqual(
				rows
					.map((row) => transformMessage(row, ["Inbox"], 160, "unused").id)
					.sort(),
			);
			const files = (await readdir(paths.messagesDir)).filter(
				(file) => file !== "_status.json",
			);
			expect(files).toHaveLength(rows.length);
			const first = await Bun.file(join(paths.messagesDir, files[0])).text();
			expect(first).not.toContain("private@example.test");
			expect(first).not.toContain("123456789");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);
});

describe("writeMessageBatchStream write failures", () => {
	test("rejects a failed chunk even when the next provider page is delayed", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-write-failure-"));
		const rows = messages(301);
		const failure = new Error("Synthetic disk write failure");
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		const originalWrite = Bun.write;
		const write = spyOn(Bun, "write").mockImplementation(
			async (target, data) => {
				if (
					typeof data === "string" &&
					JSON.parse(data).sourceMessageId === rows[280]!.id
				)
					throw failure;
				if (typeof target !== "string" || typeof data !== "string")
					throw new Error("Fixture writes require paths and string data");
				return originalWrite(target, data);
			},
		);
		async function* pages() {
			yield rows.slice(0, 300);
			await new Promise((resolve) => setTimeout(resolve, 30));
			yield rows.slice(300);
		}
		try {
			await expect(
				writeMessageBatchStream({
					paths: workspacePaths(root),
					folders: [{ id: "inbox", name: "Inbox", type: "system" }],
					pages: pages(),
					snippetLength: 160,
					workers: 3,
				}),
			).rejects.toThrow(failure.message);
			expect(unhandled).toEqual([]);
			expect(await Bun.file(workspacePaths(root).status).exists()).toBe(false);
		} finally {
			write.mockRestore();
			process.off("unhandledRejection", onUnhandled);
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("writeMessageBatchStream writer concurrency", () => {
	test("shares the configured write limit across overlapping chunks and provider pages", async () => {
		const root = await mkdtemp(join(tmpdir(), "inbox-overlapping-writes-"));
		const rows = messages(64);
		const workers = 3;
		let active = 0;
		let maximum = 0;
		let completed = 0;
		const originalWrite = Bun.write;
		const write = spyOn(Bun, "write").mockImplementation(
			async (target, data) => {
				if (typeof target !== "string" || typeof data !== "string")
					throw new Error("Fixture writes require paths and string data");
				maximum = Math.max(maximum, ++active);
				try {
					await new Promise((resolve) => setTimeout(resolve, 3));
					const result = await originalWrite(target, data);
					if (JSON.parse(data).kind === "message-work-item") completed++;
					return result;
				} finally {
					active--;
				}
			},
		);
		async function* pages() {
			yield rows.slice(0, 32);
			yield rows.slice(32);
		}
		try {
			const status = await writeMessageBatchStream({
				paths: workspacePaths(root),
				folders: [{ id: "inbox", name: "Inbox", type: "system" }],
				pages: pages(),
				snippetLength: 160,
				workers,
				chunkSize: 8,
				workerThreshold: 0,
			});
			expect(maximum).toBeGreaterThan(1);
			expect(maximum).toBeLessThanOrEqual(workers);
			expect(completed).toBe(rows.length);
			expect(status.total).toBe(rows.length);
			expect(new Set(status.items.map((item) => item.id)).size).toBe(
				rows.length,
			);
		} finally {
			write.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});
});
