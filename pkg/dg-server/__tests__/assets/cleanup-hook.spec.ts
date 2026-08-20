/** The session-close cleanup seam, which registry.close() calls before it broadcasts. */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { installAssetLifecycle } from "../../src/assets/cleanup";
import { createLogger } from "../../src/server/log";
import { ChatStore } from "../../src/store";
import {
	setAssetCleanupHook,
	triggerAssetCleanup,
} from "../../src/utils/asset-cleanup";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

let dispose: (() => void) | undefined;

afterEach(() => {
	dispose?.();
	dispose = undefined;
});

describe("setAssetCleanupHook", () => {
	it("routes to the most recent install, and stops routing once that install is disposed", () => {
		const seen: string[] = [];
		const disposeFirst = setAssetCleanupHook(() => seen.push("first"));
		const disposeSecond = setAssetCleanupHook(() => seen.push("second"));

		triggerAssetCleanup("session-1");
		expect(seen).toEqual(["second"]);

		disposeFirst();
		triggerAssetCleanup("session-1");
		expect(seen).toEqual(["second", "second"]);

		disposeSecond();
		triggerAssetCleanup("session-1");
		expect(seen).toEqual(["second", "second"]);
	});
});

describe("installAssetLifecycle", () => {
	it("swallows a cleanup failure so registry.close() still reaches its broadcast and revocation", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, {
				env: { DG_KEY_SOURCE: "file" },
			});
			dispose = installAssetLifecycle(paths, store, createLogger(paths), 47000);

			store.close();
			expect(() =>
				triggerAssetCleanup("1f0a7b6c-2d3e-4f50-8a9b-0c1d2e3f4a5b"),
			).not.toThrow();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});

describe("the asset root is only ever deleted inside when the daemon owns it", () => {
	it("refuses to sweep through a symlinked root, leaving the link's target untouched", async () => {
		const dgHome = freshDgHome();
		const victim = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const root = join(paths.assetsDir, "dg-assets");

			const session = "11111111-2222-4333-8444-555555555555";
			mkdirSync(join(victim, session, "nested"), { recursive: true });
			writeFileSync(join(victim, session, "nested", "secret.txt"), "keep me");

			mkdirSync(paths.assetsDir, { recursive: true });
			symlinkSync(victim, root, "dir");

			const store = await ChatStore.open(paths, {
				env: { DG_KEY_SOURCE: "file" },
			});
			dispose = installAssetLifecycle(paths, store, createLogger(paths), 47000);

			expect(existsSync(join(victim, session, "nested", "secret.txt"))).toBe(
				true,
			);
			expect(existsSync(join(victim, session))).toBe(true);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
			cleanupDgHome(victim);
		}
	}, 30000);

	it("prunes rows even when the root is unusable, so no row outlives bytes it can never reach", async () => {
		const dgHome = freshDgHome();
		const victim = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			mkdirSync(paths.assetsDir, { recursive: true });
			symlinkSync(victim, join(paths.assetsDir, "dg-assets"), "dir");

			const store = await ChatStore.open(paths, {
				env: { DG_KEY_SOURCE: "file" },
			});
			const session = "22222222-3333-4444-8555-666666666666";
			store.insertAsset({
				sessionId: session,
				id: "asset-1",
				filename: "x.png",
				contentType: "image/png",
				byteLength: 3,
			});
			dispose = installAssetLifecycle(paths, store, createLogger(paths), 47000);

			triggerAssetCleanup(session);
			expect(store.getAsset(session, "asset-1")?.state).toBe("deleted");
			store.close();
		} finally {
			cleanupDgHome(dgHome);
			cleanupDgHome(victim);
		}
	}, 30000);
});
