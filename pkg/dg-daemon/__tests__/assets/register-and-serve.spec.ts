import { afterEach, describe, expect, it } from "bun:test";
import {
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CHAT_MAX_ASSET_BYTES } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { installAssetLifecycle } from "../../src/assets/cleanup";
import { getConfiguredAssetDirectory } from "../../src/assets/config";
import { readAssetSourceFile, registerAsset } from "../../src/assets/register";
import { resolveAssetForServing } from "../../src/assets/serve";
import { createLogger } from "../../src/server/log";
import { SessionRegistry } from "../../src/session/registry";
import { AssetTooLargeError, ChatStore } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	freshTempDir,
} from "../utils/daemon-harness";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let disposeLifecycle: (() => void) | undefined;

afterEach(() => {
	disposeLifecycle?.();
	disposeLifecycle = undefined;
});

async function setup(dgHome: string) {
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
	const registry = new SessionRegistry(paths);
	const scratch = freshTempDir("dg-asset-cwd");
	const session = registry.create({
		cwd: scratch,
		agentIdentity: "test-agent",
		role: "agent",
	});
	return {
		paths,
		store,
		registry,
		session,
		scratch,
		root: getConfiguredAssetDirectory(paths),
		installLifecycle: () => {
			disposeLifecycle = installAssetLifecycle(
				paths,
				store,
				createLogger(paths),
				47000,
			);
		},
	};
}

describe("readAssetSourceFile", () => {
	it("refuses an oversized source on the fd's own size, before reading it into memory", () => {
		const scratch = freshTempDir("dg-asset-source");
		const path = join(scratch, "huge.bin");
		const fd = openSync(path, "w");
		ftruncateSync(fd, CHAT_MAX_ASSET_BYTES + 1);
		closeSync(fd);

		expect(() => readAssetSourceFile(path)).toThrow(AssetTooLargeError);
	});

	it("refuses a source that is not a regular file at all", () => {
		const scratch = freshTempDir("dg-asset-source-dir");
		expect(() => readAssetSourceFile(scratch)).toThrow(/regular file/i);
	});
});

describe("registerAsset + resolveAssetForServing", () => {
	it("refuses to stage through a symlinked SESSION directory planted before the first write", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, session } = await setup(dgHome);
			const root = getConfiguredAssetDirectory(paths);
			mkdirSync(root, { recursive: true });
			const elsewhere = freshTempDir("dg-asset-escape");
			symlinkSync(elsewhere, join(root, session.sessionId));

			await expect(
				registerAsset(
					{ paths, store },
					{
						sessionId: session.sessionId,
						id: "asset-escape",
						filename: "leak.png",
						contentType: "image/png",
						bytes: Buffer.from([1, 2, 3]),
					},
				),
			).rejects.toThrow(/not a real directory/);

			expect(existsSync(join(elsewhere, "asset-escape"))).toBe(false);
			rmSync(elsewhere, { recursive: true, force: true });
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("still stages normally when the session directory is a real directory", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session } = await setup(dgHome);
			const root = getConfiguredAssetDirectory(paths);
			mkdirSync(join(root, session.sessionId), { recursive: true });

			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-real",
					filename: "ok.png",
					contentType: "image/png",
					bytes: Buffer.from([9, 8, 7]),
				},
			);

			const result = await resolveAssetForServing(
				{ paths, store, registry },
				{
					sessionId: session.sessionId,
					token: session.token,
					id: "asset-real",
				},
			);
			expect(result.status).toBe("ok");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("round-trips staged bytes: retrievable with the valid session capability, byte-identical", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session } = await setup(dgHome);
			const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-1",
					filename: "picture.png",
					contentType: "image/png",
					bytes,
				},
			);

			const result = await resolveAssetForServing(
				{ paths, store, registry },
				{ sessionId: session.sessionId, token: session.token, id: "asset-1" },
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.bytes.equals(bytes)).toBe(true);
				expect(result.contentType).toBe("image/png");
				expect(result.inline).toBe(true);
				expect(result.filename).toBe("picture.png");
			}
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("stages the envelope as <12-byte iv><16-byte tag><ciphertext>, in that ORDER", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, session, root } = await setup(dgHome);
			const bytes = Buffer.from("envelope order matters");

			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-1",
					filename: "picture.png",
					contentType: "image/png",
					bytes,
				},
			);

			const raw = readFileSync(join(root, session.sessionId, "asset-1"));
			const base64Length = 4 * Math.ceil(bytes.byteLength / 3);
			expect(raw.byteLength).toBe(IV_LENGTH + TAG_LENGTH + base64Length);

			const iv = raw.subarray(0, IV_LENGTH);
			const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
			const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
			expect(
				store
					.decryptAssetBytes(session.sessionId, "asset-1", {
						iv,
						tag,
						ciphertext,
					})
					.equals(bytes),
			).toBe(true);

			expect(() =>
				store.decryptAssetBytes(session.sessionId, "asset-1", {
					iv: raw.subarray(TAG_LENGTH, TAG_LENGTH + IV_LENGTH),
					tag: raw.subarray(0, TAG_LENGTH),
					ciphertext,
				}),
			).toThrow();
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("types the response from the ROW's filename, never the contentType the caller declared", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session } = await setup(dgHome);
			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-safe",
					filename: "safe.png",
					contentType: "text/html",
					bytes: Buffer.from("PNG-ish"),
				},
			);
			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-evil",
					filename: "evil.html",
					contentType: "image/png",
					bytes: Buffer.from("<script>alert(1)</script>"),
				},
			);

			const safe = await resolveAssetForServing(
				{ paths, store, registry },
				{
					sessionId: session.sessionId,
					token: session.token,
					id: "asset-safe",
				},
			);
			expect(safe.status).toBe("ok");
			if (safe.status === "ok") {
				expect(safe.contentType).toBe("image/png");
				expect(safe.inline).toBe(true);
			}

			const evil = await resolveAssetForServing(
				{ paths, store, registry },
				{
					sessionId: session.sessionId,
					token: session.token,
					id: "asset-evil",
				},
			);
			expect(evil.status).toBe("ok");
			if (evil.status === "ok") {
				expect(evil.contentType).toBe("text/html");
				expect(evil.inline).toBe(false);
			}
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("refuses a request with no valid capability — status unauthorized", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session } = await setup(dgHome);
			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-1",
					filename: "picture.png",
					contentType: "image/png",
					bytes: Buffer.from("hi"),
				},
			);

			const wrongToken = await resolveAssetForServing(
				{ paths, store, registry },
				{
					sessionId: session.sessionId,
					token: "not-the-real-token",
					id: "asset-1",
				},
			);
			expect(wrongToken.status).toBe("unauthorized");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("distinguishes unknown-id from wrong-token from a session CLOSE that pruned the row", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session, installLifecycle } =
				await setup(dgHome);
			installLifecycle();
			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-1",
					filename: "picture.png",
					contentType: "image/png",
					bytes: Buffer.from("hi"),
				},
			);

			const unknown = await resolveAssetForServing(
				{ paths, store, registry },
				{
					sessionId: session.sessionId,
					token: session.token,
					id: "never-existed",
				},
			);
			expect(unknown.status).toBe("unknown");

			const wrongToken = await resolveAssetForServing(
				{ paths, store, registry },
				{ sessionId: session.sessionId, token: "bogus", id: "asset-1" },
			);
			expect(wrongToken.status).toBe("unauthorized");

			expect(registry.close(session.sessionId, "cli")).toBe(true);
			const pruned = await resolveAssetForServing(
				{ paths, store, registry },
				{ sessionId: session.sessionId, token: session.token, id: "asset-1" },
			);
			expect(pruned.status).toBe("pruned");

			const statuses = new Set([
				unknown.status,
				wrongToken.status,
				pruned.status,
			]);
			expect(statuses.size).toBe(3);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("removes the closed session's staged directory while leaving the assets root and its siblings alone", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session, root, installLifecycle } =
				await setup(dgHome);
			installLifecycle();
			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-1",
					filename: "picture.png",
					contentType: "image/png",
					bytes: Buffer.from("hi"),
				},
			);
			const sentinel = join(root, "sentinel.txt");
			writeFileSync(sentinel, "must survive every cleanup");

			registry.close(session.sessionId, "cli");

			expect(existsSync(join(root, session.sessionId))).toBe(false);
			expect(existsSync(root)).toBe(true);
			expect(existsSync(sentinel)).toBe(true);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("answers a CLOSED session whose rows were never pruned distinguishably from a bad token", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session } = await setup(dgHome);
			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-1",
					filename: "picture.png",
					contentType: "image/png",
					bytes: Buffer.from("hi"),
				},
			);
			registry.close(session.sessionId, "cli");

			const closed = await resolveAssetForServing(
				{ paths, store, registry },
				{ sessionId: session.sessionId, token: session.token, id: "asset-1" },
			);
			expect(closed.status).toBe("session-closed");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("rejects registering bytes over CHAT_MAX_ASSET_BYTES, leaving no row and no on-disk file behind", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, session, root } = await setup(dgHome);
			const oversized = Buffer.alloc(CHAT_MAX_ASSET_BYTES + 1024, 1);

			await expect(
				registerAsset(
					{ paths, store },
					{
						sessionId: session.sessionId,
						id: "asset-huge",
						filename: "huge.bin",
						contentType: "application/octet-stream",
						bytes: oversized,
					},
				),
			).rejects.toThrow(AssetTooLargeError);

			expect(store.getAsset(session.sessionId, "asset-huge")).toBeUndefined();
			expect(existsSync(join(root, session.sessionId, "asset-huge"))).toBe(
				false,
			);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("refuses an oversized staged file on the SIZE of its fd, before reading or decrypting a byte", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session, root } = await setup(dgHome);
			store.insertAsset({
				sessionId: session.sessionId,
				id: "asset-huge",
				filename: "huge.png",
				contentType: "image/png",
				byteLength: 1,
			});
			mkdirSync(join(root, session.sessionId), { recursive: true });
			const fd = openSync(join(root, session.sessionId, "asset-huge"), "w");
			ftruncateSync(fd, CHAT_MAX_ASSET_BYTES * 4);
			closeSync(fd);

			const result = await resolveAssetForServing(
				{ paths, store, registry },
				{
					sessionId: session.sessionId,
					token: session.token,
					id: "asset-huge",
				},
			);
			expect(result.status).toBe("too-large");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("admits an envelope at the full base64-expanded ceiling — a legitimate max-size asset is encrypted from its base64 text, not its raw bytes", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session, root } = await setup(dgHome);
			store.insertAsset({
				sessionId: session.sessionId,
				id: "asset-ceiling",
				filename: "ceiling.png",
				contentType: "image/png",
				byteLength: CHAT_MAX_ASSET_BYTES,
			});
			mkdirSync(join(root, session.sessionId), { recursive: true });
			const fd = openSync(join(root, session.sessionId, "asset-ceiling"), "w");
			ftruncateSync(fd, 12 + 16 + 4 * Math.ceil(CHAT_MAX_ASSET_BYTES / 3));
			closeSync(fd);

			const result = await resolveAssetForServing(
				{ paths, store, registry },
				{
					sessionId: session.sessionId,
					token: session.token,
					id: "asset-ceiling",
				},
			);
			expect(result.status).toBe("corrupt");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("reports a row whose staged bytes are gone as missing, not as a containment refusal", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session, root } = await setup(dgHome);
			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-1",
					filename: "picture.png",
					contentType: "image/png",
					bytes: Buffer.from("hi"),
				},
			);
			rmSync(join(root, session.sessionId, "asset-1"));

			const result = await resolveAssetForServing(
				{ paths, store, registry },
				{ sessionId: session.sessionId, token: session.token, id: "asset-1" },
			);
			expect(result.status).toBe("missing-file");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("reports a tampered envelope as corrupt, distinct from both missing and unsafe", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session, root } = await setup(dgHome);
			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-1",
					filename: "picture.png",
					contentType: "image/png",
					bytes: Buffer.from("hi"),
				},
			);
			const staged = join(root, session.sessionId, "asset-1");
			const raw = readFileSync(staged);
			raw[raw.byteLength - 1] ^= 0xff;
			writeFileSync(staged, raw);

			const result = await resolveAssetForServing(
				{ paths, store, registry },
				{ sessionId: session.sessionId, token: session.token, id: "asset-1" },
			);
			expect(result.status).toBe("corrupt");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("refuses to write through a symlink pre-planted at the staging path — no-follow, not a bare writeFile", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, session, scratch, root } = await setup(dgHome);
			const outsideTarget = join(scratch, "outside-target");
			mkdirSync(join(root, session.sessionId), { recursive: true });
			writeFileSync(outsideTarget, "must not be touched");
			symlinkSync(outsideTarget, join(root, session.sessionId, "asset-1"));

			await expect(
				registerAsset(
					{ paths, store },
					{
						sessionId: session.sessionId,
						id: "asset-1",
						filename: "picture.png",
						contentType: "image/png",
						bytes: Buffer.from("attacker-controlled overwrite attempt"),
					},
				),
			).rejects.toThrow();

			expect(readFileSync(outsideTarget, "utf8")).toBe("must not be touched");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("refuses to serve an asset whose on-disk file was swapped for a symlink after registration — status unsafe-path", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session, scratch, root } =
				await setup(dgHome);
			await registerAsset(
				{ paths, store },
				{
					sessionId: session.sessionId,
					id: "asset-1",
					filename: "picture.png",
					contentType: "image/png",
					bytes: Buffer.from("hi"),
				},
			);

			const outsideTarget = join(scratch, "swapped-target");
			writeFileSync(outsideTarget, "someone else's bytes");
			rmSync(join(root, session.sessionId, "asset-1"));
			symlinkSync(outsideTarget, join(root, session.sessionId, "asset-1"));

			const result = await resolveAssetForServing(
				{ paths, store, registry },
				{ sessionId: session.sessionId, token: session.token, id: "asset-1" },
			);
			expect(result.status).toBe("unsafe-path");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
