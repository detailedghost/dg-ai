import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Window } from "happy-dom";
import { hashBundle } from "../../skills-cli/build";
import { buildPlayer, PLAYER_BUDGET_BYTES } from "../build";

const PKG = resolve(import.meta.dir, "..");
let code = "";

describe("dist/player.js", () => {
	beforeAll(async () => {
		const build = Bun.spawn([process.execPath, "build.ts"], {
			cwd: PKG,
			stdout: "pipe",
			stderr: "pipe",
		});
		const failure = await new Response(build.stderr).text();
		expect(await build.exited, failure).toBe(0);
		code = readFileSync(join(PKG, "dist", "player.js"), "utf8");
	}, 60_000);

	it("stays under the 120 KB minified budget", () => {
		expect(Buffer.byteLength(code)).toBeLessThan(PLAYER_BUDGET_BYTES);
	});

	it("carries no extension API", () => {
		expect(code).not.toContain("wxt/browser");
		expect(code).not.toContain("chrome.runtime");
	});

	it("evaluates in happy-dom and defines window.__dgTour.run", () => {
		const win = new Window({ url: "https://app.example/start" });

		win.eval(code);

		const tour = (win as unknown as { __dgTour?: { run?: unknown } }).__dgTour;
		expect(typeof tour?.run).toBe("function");
	});
});

describe("build wiring", () => {
	it("runs the tour-ui build from the launcher bundle build", () => {
		const text = readFileSync(
			join(PKG, "..", "launcher", "build.ts"),
			"utf8",
		);
		expect(text).toContain("tour-ui");
	});
});

describe("build hash", () => {
	it("changes when the player source changes", async () => {
		const entry = join(PKG, "src", "index.ts");
		const dir = mkdtempSync(join(tmpdir(), "player-hash-"));
		try {
			const source = join(dir, "player-entry.ts");
			const build = async (body: string): Promise<string> => {
				writeFileSync(source, body);
				return hashBundle(entry, [], [await buildPlayer(source, dir)]);
			};

			const first = await build("(globalThis as any).__tour = 1;");
			const same = await build("(globalThis as any).__tour = 1;");
			const second = await build("(globalThis as any).__tour = 2;");

			expect(same).toBe(first);
			expect(second).not.toBe(first);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
