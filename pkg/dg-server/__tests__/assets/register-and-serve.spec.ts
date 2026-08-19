/**
 * registerAsset + resolveAssetForServing: the write-and-read halves of the
 * asset row Code Structure assigns to slice 9 (stage writes only the file;
 * slice 9 writes the row and serves it back). Module-level, no daemon
 * subprocess needed — SessionRegistry supplies a real capability pair the
 * same way the HTTP layer's registry.validate() would.
 *
 * [SPEC] ASSUMED module surface — registerAsset/resolveAssetForServing/
 * AssetServeResult are this pass's invention; see deferrals. The no-follow
 * write requirement (Engineering, explicit) is tested by pre-planting a
 * symlink at the exact path the write would use and confirming the write
 * refuses rather than following it.
 */
import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_MAX_ASSET_BYTES } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { registerAsset } from "../../src/assets/register";
import { resolveAssetForServing } from "../../src/assets/serve";
import { SessionRegistry } from "../../src/session/registry";
import { AssetTooLargeError, ChatStore } from "../../src/store";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

const FILE_ONLY_SEAMS = { env: { DG_KEY_SOURCE: "file" } };

async function setup(dgHome: string) {
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
	const registry = new SessionRegistry(paths);
	const scratch = mkdtempSync(join(tmpdir(), "dg-asset-cwd-"));
	const session = registry.create({
		cwd: scratch,
		agentIdentity: "test-agent",
		role: "agent",
	});
	return { paths, store, registry, session, scratch };
}

describe("registerAsset + resolveAssetForServing", () => {
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

	it("distinguishes unknown-id from wrong-token from a pruned asset — three different reasons", async () => {
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

			store.pruneSessionAssets(session.sessionId);
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
			expect(statuses.size).toBe(3); // all three genuinely distinct
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("rejects registering bytes over CHAT_MAX_ASSET_BYTES, leaving no row and no on-disk file behind", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, session } = await setup(dgHome);
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
			expect(
				existsSync(join(paths.assetsDir, session.sessionId, "asset-huge")),
			).toBe(false);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("refuses to write through a symlink pre-planted at the staging path — no-follow, not a bare writeFile", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, session, scratch } = await setup(dgHome);
			const outsideTarget = join(scratch, "outside-target");
			mkdirSync(join(paths.assetsDir, session.sessionId), { recursive: true });
			writeFileSync(outsideTarget, "must not be touched");
			symlinkSync(
				outsideTarget,
				join(paths.assetsDir, session.sessionId, "asset-1"),
			);

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

			// The outside file must be untouched — a no-follow write refuses
			// before ever writing bytes through the symlink.
			expect(readFileSync(outsideTarget, "utf8")).toBe("must not be touched");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("refuses to serve an asset whose on-disk file was swapped for a symlink after registration — status unsafe-path", async () => {
		const dgHome = freshDgHome();
		try {
			const { paths, store, registry, session, scratch } = await setup(dgHome);
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

			// Simulate TOCTOU tampering: swap the legitimately-registered file for
			// a symlink pointing outside the session directory.
			const outsideTarget = join(scratch, "swapped-target");
			writeFileSync(outsideTarget, "someone else's bytes");
			rmSync(join(paths.assetsDir, session.sessionId, "asset-1"));
			symlinkSync(
				outsideTarget,
				join(paths.assetsDir, session.sessionId, "asset-1"),
			);

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
