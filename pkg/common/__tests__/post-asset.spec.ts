import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postAsset, readAssetSourceFile } from "../src/node/assets";

const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("postAsset", () => {
	it("posts the bytes with the session capability and returns the asset id", async () => {
		const seen: { headers: Record<string, string>; body: string }[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				seen.push({
					headers: Object.fromEntries(req.headers),
					body: await req.text(),
				});
				return Response.json({ assetId: "a1" });
			},
		});
		servers.push(server);
		const id = await postAsset(
			{ port: server.port as number, sessionId: "s1", token: "t1" },
			"my file.txt",
			Buffer.from("hello"),
		);
		expect(id).toBe("a1");
		expect(seen[0]?.body).toBe("hello");
		expect(seen[0]?.headers["x-dg-session-id"]).toBe("s1");
		expect(seen[0]?.headers["x-dg-session-token"]).toBe("t1");
		expect(seen[0]?.headers["x-dg-filename"]).toBe("my%20file.txt");
	});

	it("throws the daemon's refusal", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("refused: too big", { status: 413 }),
		});
		servers.push(server);
		await expect(
			postAsset({ port: server.port as number, sessionId: "s", token: "t" }, "a", Buffer.from("x")),
		).rejects.toThrow("refused: too big");
	});
});

describe("readAssetSourceFile noFollow", () => {
	it("refuses a symbolic link", () => {
		const dir = mkdtempSync(join(tmpdir(), "asset-"));
		dirs.push(dir);
		writeFileSync(join(dir, "real.txt"), "x");
		symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
		expect(readAssetSourceFile(join(dir, "real.txt"), { noFollow: true }).toString()).toBe("x");
		expect(() => readAssetSourceFile(join(dir, "link.txt"), { noFollow: true })).toThrow();
	});
});
