import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDraft } from "../src/drafts/store";
import { writeJournal } from "../src/signal/journal";

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

describe("private message files", () => {
	test("drafts and the signal journal are 0600 inside a 0700 directory", () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-mode-"));
		const previous = process.umask(0o022);
		try {
			writeDraft(home, {
				id: "d1",
				provider: "signal",
				conversationId: "c1",
				text: "secret-body",
				attachments: [],
				createdAt: "2026-10-31T00:00:00.000Z",
				status: "pending",
			});
			writeJournal(home, [
				{
					id: "m1",
					conversationId: "c1",
					timestamp: 1,
					direction: "in",
					senderId: "u2",
					text: "secret-body",
					attachments: [],
				},
			]);
		} finally {
			process.umask(previous);
		}
		expect(mode(join(home, "ssms", "drafts"))).toBe(0o700);
		expect(mode(join(home, "ssms", "drafts", "d1.json"))).toBe(0o600);
		expect(mode(join(home, "ssms", "signal"))).toBe(0o700);
		expect(mode(join(home, "ssms", "signal", "journal.json"))).toBe(0o600);
	});
});
