import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberIds, resolveId } from "../ids";

async function withWorkspace(run: (workspaceDir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "dg-inbox-mail-ids-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("mail ids", () => {
	test("resolves a remembered hash back to its private provider id", async () => {
		await withWorkspace(async (dir) => {
			await rememberIds(dir, [{ hash: "m_hash_aaa", id: "provider-id-1" }]);
			expect(await resolveId(dir, "m_hash_aaa")).toBe("provider-id-1");
			expect(await resolveId(dir, "m_hash_missing")).toBeUndefined();
		});
	});

	test("writes ids.json with mode 0600", async () => {
		await withWorkspace(async (dir) => {
			await rememberIds(dir, [{ hash: "m_hash_aaa", id: "provider-id-1" }]);
			const stats = await stat(join(dir, "mail", "ids.json"));
			expect(stats.mode & 0o777).toBe(0o600);
		});
	});

	test("drops the oldest entry when 5001 ids are remembered", async () => {
		await withWorkspace(async (dir) => {
			const entries = Array.from({ length: 5001 }, (_, index) => ({
				hash: `m_hash_${index}`,
				id: `provider-id-${index}`,
			}));
			await rememberIds(dir, entries);
			expect(await resolveId(dir, "m_hash_0")).toBeUndefined();
			expect(await resolveId(dir, "m_hash_1")).toBe("provider-id-1");
			expect(await resolveId(dir, "m_hash_5000")).toBe("provider-id-5000");
		});
	});

	test("merges across separate calls while keeping the 5000 cap", async () => {
		await withWorkspace(async (dir) => {
			await rememberIds(
				dir,
				Array.from({ length: 4999 }, (_, index) => ({
					hash: `m_hash_a${index}`,
					id: `provider-a${index}`,
				})),
			);
			await rememberIds(dir, [
				{ hash: "m_hash_b0", id: "provider-b0" },
				{ hash: "m_hash_b1", id: "provider-b1" },
			]);
			expect(await resolveId(dir, "m_hash_a0")).toBeUndefined();
			expect(await resolveId(dir, "m_hash_a1")).toBe("provider-a1");
			expect(await resolveId(dir, "m_hash_b1")).toBe("provider-b1");
		});
	});
});
