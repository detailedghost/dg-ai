import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { statSync } from "node:fs";
import { resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import { applyConnectionPragmas } from "../../src/store/connection";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

const REQUIRED_TABLES = [
	"sessions",
	"messages",
	"status_events",
	"assets",
	"command_invocations",
	"crypto_meta",
];

describe("ChatStore.open — connection + schema", () => {
	it("creates all six tables, each declared STRICT", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			const raw = new Database(paths.dbPath, { readonly: true });
			for (const table of REQUIRED_TABLES) {
				const row = raw
					.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
					.get(table) as { sql: string } | null;
				expect(row).not.toBeNull();
				expect(row?.sql.toUpperCase()).toContain("STRICT");
			}
			raw.close(true);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("sets WAL journal mode, foreign_keys ON, and a positive busy_timeout", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			const raw = new Database(paths.dbPath, { readonly: true });
			expect(
				(raw.query("PRAGMA journal_mode").get() as { journal_mode: string })
					.journal_mode,
			).toBe("wal");
			applyConnectionPragmas(raw);
			expect(
				(raw.query("PRAGMA foreign_keys").get() as { foreign_keys: number })
					.foreign_keys,
			).toBe(1);
			expect(
				(raw.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
			).toBeGreaterThan(0);
			raw.close(true);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("creates the daemon directory at mode 0700", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			expect(statSync(paths.daemonDir).mode & 0o777).toBe(0o700);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("fixes a pre-existing daemon directory that is not 0700, and warns audibly naming the prior mode", async () => {
		const dgHome = freshDgHome();
		try {
			const { chmodSync, mkdirSync } = await import("node:fs");
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			mkdirSync(paths.daemonDir, { recursive: true });
			chmodSync(paths.daemonDir, 0o755);

			const warn = spyOn(console, "warn").mockImplementation(() => {});
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			expect(statSync(paths.daemonDir).mode & 0o777).toBe(0o700);
			const messages = warn.mock.calls
				.map((call) => String(call[0]))
				.join("\n");
			expect(messages).toContain("755");
			warn.mockRestore();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("persists a crypto_meta row (format_version, key_id, key_source, wrapped key) on first open", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			const meta = store.cryptoMeta();
			expect(typeof meta.formatVersion).toBe("number");
			expect(typeof meta.keyId).toBe("string");
			expect(meta.keyId.length).toBeGreaterThan(0);
			expect(meta.keySource).toBe("file");
			expect(Buffer.isBuffer(meta.wrappedDataKey)).toBe(true);
			expect(meta.wrappedDataKey.length).toBeGreaterThan(0);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
