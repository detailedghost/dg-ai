import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { registerAsset } from "../src/assets/register";
import { createPairingCode } from "../src/pairing";
import { writeConfig } from "../src/server/config-store";
import type { ChatStore } from "../src/store";

const posix = describe.skipIf(process.platform === "win32");

let home: string;

function put(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-daemon-write-guard-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

posix("dg-daemon writers refuse an unmoved legacy entry", () => {
	it("writeConfig creates no daemon folder while the legacy daemon folder holds data", () => {
		const paths = resolveDgPaths({ env: {}, homeDir: home });
		put(join(paths.legacyHome, "daemon", "daemon.db"), "rows");

		expect(() => writeConfig(paths, { pinnedOrigin: undefined })).toThrow(DgCliError);
		expect(existsSync(paths.daemonDir)).toBe(false);
	});

	it("createPairingCode creates no pairing.json while the legacy pairing.json holds data", () => {
		const paths = resolveDgPaths({ env: {}, homeDir: home });
		put(join(paths.legacyHome, "pairing.json"), "{}");

		expect(() => createPairingCode(paths)).toThrow(DgCliError);
		expect(existsSync(paths.pairingPath)).toBe(false);
		expect(existsSync(`${paths.pairingPath}.lock`)).toBe(false);
	});

	it("registerAsset creates no assets folder while the legacy agents/assets folder holds data", async () => {
		const paths = resolveDgPaths({ env: {}, homeDir: home });
		put(join(paths.legacyHome, "agents", "assets", "s", "a"), "old");
		const store = {
			encryptAssetBytes: () => ({ iv: Buffer.alloc(12), tag: Buffer.alloc(16), ciphertext: Buffer.alloc(1) }),
			insertAsset: () => {},
		} as unknown as ChatStore;

		const attempt = registerAsset(
			{ paths, store },
			{ sessionId: "s1", id: "a1", filename: "f.png", contentType: "image/png", bytes: Buffer.from("x") },
		);

		await expect(attempt).rejects.toBeInstanceOf(DgCliError);
		expect(existsSync(paths.assetsDir)).toBe(false);
	});
});
