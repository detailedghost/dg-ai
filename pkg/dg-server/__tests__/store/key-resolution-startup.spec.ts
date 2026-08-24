import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { resolveDgPaths } from "@dg/common/node";
import { mintFallbackKeyFile } from "../../src/crypto/key-file";
import { fingerprintKey } from "../../src/crypto/key-resolution";
import { ChatStore } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

const SESSION_ID = "session-restart-1";

describe("ChatStore.open — key resolution across restarts", () => {
	it("reopening with the SAME key file resolves the same data key — a message written before restart is still readable after", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const first = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			first.insertMessage({
				sessionId: SESSION_ID,
				id: "m1",
				role: "user",
				body: "still readable after restart",
			});
			first.close();

			const reopened = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const messages = reopened.peekAll(SESSION_ID);

			expect(messages.map((m) => m.body)).toEqual([
				"still readable after restart",
			]);
			reopened.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("REFUSES to start when the key file has been replaced with an unrelated key — and does not silently mint a second one", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const first = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const recordedKeyId = first.cryptoMeta().keyId;
			first.close();

			rmSync(paths.keyPath, { force: true });
			const unrelatedKek = randomBytes(32);
			mintFallbackKeyFile(
				paths.keyPath,
				unrelatedKek,
				fingerprintKey(unrelatedKek),
			);

			await expect(ChatStore.open(paths, FILE_ONLY_SEAMS)).rejects.toThrow();

			const raw = new Database(paths.dbPath, { readonly: true });
			const row = raw.query("SELECT key_id FROM crypto_meta").get() as {
				key_id: string;
			};
			raw.close(true);
			expect(row.key_id).toBe(recordedKeyId);
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("DG_KEY_SOURCE=file never touches an injected keychain backend, even when one is supplied", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			let lookupCalls = 0;
			const keychain = {
				async lookup() {
					lookupCalls++;
					throw new Error(
						"the suite must never touch a real/injected keychain in file mode",
					);
				},
				async store() {
					lookupCalls++;
					throw new Error(
						"the suite must never touch a real/injected keychain in file mode",
					);
				},
			};

			const store = await ChatStore.open(paths, {
				env: { DG_KEY_SOURCE: "file" },
				keychain,
			});

			expect(lookupCalls).toBe(0);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
