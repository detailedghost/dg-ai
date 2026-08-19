/**
 * Real schema + connection setup: bun:sqlite strict:true, STRICT tables,
 * WAL, foreign_keys ON, busy_timeout, and a crypto_meta row on first open.
 * A wrong-mode state directory self-heals to 0700 AND warns audibly naming
 * the prior mode (ratified) — a silent chmod would hide a leaked window.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { statSync } from "node:fs";
import { resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import { applyConnectionPragmas } from "../../src/store/connection";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

const FILE_ONLY_SEAMS = { env: { DG_KEY_SOURCE: "file" } };

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

			// foreign_keys/busy_timeout are per-connection, resetting to 0 on any
			// fresh connection (verified empirically) — checked via the same setup routine ChatStore.open() itself uses.
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

	it("creates the state directory at mode 0700", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("fixes a pre-existing state directory that is not 0700, and warns audibly naming the prior mode", async () => {
		const dgHome = freshDgHome();
		try {
			const { chmodSync, mkdirSync } = await import("node:fs");
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			mkdirSync(paths.stateDir, { recursive: true });
			chmodSync(paths.stateDir, 0o755);

			const warn = spyOn(console, "warn").mockImplementation(() => {});
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700);
			// A silent chmod would hide that the db/-wal had been group/world-readable.
			const messages = warn.mock.calls
				.map((call) => String(call[0]))
				.join("\n");
			expect(messages).toContain("755"); // names the PRIOR mode, not the new 0700
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
