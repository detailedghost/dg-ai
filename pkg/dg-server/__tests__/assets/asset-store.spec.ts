import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { CHAT_MAX_ASSET_BYTES } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { AssetTooLargeError, ChatStore } from "../../src/store";
import { runMigrations } from "../../src/store/migrations";
import { SCHEMA_STEPS } from "../../src/store/schema";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	scanFileForBytes as scanFile,
} from "../utils/daemon-harness";

const SESSION_A = "session-asset-a";
const SESSION_B = "session-asset-b";

describe("ChatStore asset row write-path", () => {
	it("insertAsset + getAsset round-trips filename/contentType/byteLength, scoped to the session, state active", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			store.insertAsset({
				sessionId: SESSION_A,
				id: "asset-1",
				filename: "picture.png",
				contentType: "image/png",
				byteLength: 1234,
			});

			const row = store.getAsset(SESSION_A, "asset-1");
			expect(row?.filename).toBe("picture.png");
			expect(row?.contentType).toBe("image/png");
			expect(row?.byteLength).toBe(1234);
			expect(row?.state).toBe("active");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("scopes getAsset to the requesting session — another session's own id lookup finds nothing, not a cross-session leak", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertAsset({
				sessionId: SESSION_A,
				id: "asset-1",
				filename: "picture.png",
				contentType: "image/png",
				byteLength: 10,
			});

			expect(store.getAsset(SESSION_B, "asset-1")).toBeUndefined();
			expect(store.getAsset(SESSION_A, "never-existed")).toBeUndefined();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("pruneSessionAssets marks only the target session's active rows deleted, leaving other sessions untouched", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertAsset({
				sessionId: SESSION_A,
				id: "asset-1",
				filename: "a.png",
				contentType: "image/png",
				byteLength: 10,
			});
			store.insertAsset({
				sessionId: SESSION_B,
				id: "asset-2",
				filename: "b.png",
				contentType: "image/png",
				byteLength: 10,
			});

			store.pruneSessionAssets(SESSION_A);

			expect(store.getAsset(SESSION_A, "asset-1")?.state).toBe("deleted");
			expect(store.getAsset(SESSION_B, "asset-2")?.state).toBe("active");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("rejects an asset row exceeding CHAT_MAX_ASSET_BYTES, inserting no row at all", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			expect(() =>
				store.insertAsset({
					sessionId: SESSION_A,
					id: "asset-huge",
					filename: "huge.bin",
					contentType: "application/octet-stream",
					byteLength: CHAT_MAX_ASSET_BYTES + 1,
				}),
			).toThrow(AssetTooLargeError);
			expect(store.getAsset(SESSION_A, "asset-huge")).toBeUndefined();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("keeps the display filename out of the db file and its -wal sidecar — encrypted at rest, like every other field", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const needle = "NEEDLE-ASSET-FILENAME-2c7e91.png";

			store.insertAsset({
				sessionId: SESSION_A,
				id: "asset-scan",
				filename: needle,
				contentType: "image/png",
				byteLength: 10,
			});

			expect(scanFile(`${paths.dbPath}-wal`, needle)).toBe(false);
			store.close();
			expect(scanFile(paths.dbPath, needle)).toBe(false);
			expect(scanFile(`${paths.dbPath}-wal`, needle)).toBe(false);
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("encryptAssetBytes/decryptAssetBytes round-trips arbitrary bytes for the same session+id", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const plaintext = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

			const envelope = store.encryptAssetBytes(SESSION_A, "asset-1", plaintext);
			expect(envelope.ciphertext.equals(plaintext)).toBe(false);

			const decrypted = store.decryptAssetBytes(SESSION_A, "asset-1", envelope);
			expect(decrypted.equals(plaintext)).toBe(true);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("binds asset bytes to their own sessionId+id — decrypting under a different id fails loudly rather than returning wrong bytes", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const envelope = store.encryptAssetBytes(
				SESSION_A,
				"asset-1",
				Buffer.from("original bytes"),
			);

			expect(() =>
				store.decryptAssetBytes(SESSION_A, "asset-DIFFERENT", envelope),
			).toThrow();
			expect(() =>
				store.decryptAssetBytes(SESSION_B, "asset-1", envelope),
			).toThrow();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("constrains assets.state to the two known values, so an unexpected one cannot be stored at all", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertAsset({
				sessionId: SESSION_A,
				id: "asset-1",
				filename: "picture.png",
				contentType: "image/png",
				byteLength: 10,
			});
			store.close();

			const raw = new Database(paths.dbPath, { strict: true });
			expect(() =>
				raw.run("UPDATE assets SET state = 'quarantined' WHERE id = 'asset-1'"),
			).toThrow();
			raw.close(true);
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("coerces an unrecognized pre-v3 state to deleted while migrating, rather than carrying a servable unknown forward", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
			const legacy = new Database(paths.dbPath, { strict: true, create: true });
			runMigrations(legacy, SCHEMA_STEPS.slice(0, 2));
			legacy.run("INSERT INTO sessions (id, created_at) VALUES (?, ?)", [
				SESSION_A,
				new Date().toISOString(),
			]);
			legacy.run(
				`INSERT INTO assets (id, session_id, created_at, filename_ciphertext, filename_iv, filename_tag, content_type, byte_length, deleted_at, state)
				 VALUES ('legacy-1', ?, ?, X'00', X'00', X'00', 'image/png', 10, NULL, 'wat')`,
				[SESSION_A, new Date().toISOString()],
			);
			legacy.close(true);

			const migrated = new Database(paths.dbPath, { strict: true });
			runMigrations(migrated, SCHEMA_STEPS);
			const row = migrated
				.query("SELECT state FROM assets WHERE id = 'legacy-1'")
				.get() as { state: string };
			expect(row.state).toBe("deleted");
			migrated.close(true);
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("uses a DIFFERENT AAD domain for filenames than for bytes — a filename's own envelope cannot decrypt as bytes", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			store.insertAsset({
				sessionId: SESSION_A,
				id: "asset-1",
				filename: "picture.png",
				contentType: "image/png",
				byteLength: 10,
			});
			store.close();

			const raw = new Database(paths.dbPath, { readonly: true });
			const row = raw
				.query(
					"SELECT filename_ciphertext, filename_iv, filename_tag FROM assets WHERE id = ?",
				)
				.get("asset-1") as {
				filename_ciphertext: Uint8Array;
				filename_iv: Uint8Array;
				filename_tag: Uint8Array;
			};
			raw.close(true);

			const reopened = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			expect(() =>
				reopened.decryptAssetBytes(SESSION_A, "asset-1", {
					ciphertext: Buffer.from(row.filename_ciphertext),
					iv: Buffer.from(row.filename_iv),
					tag: Buffer.from(row.filename_tag),
				}),
			).toThrow();
			reopened.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
