import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/verify";
import { readBoard, verifyPaths, type Section } from "../src/verify/board";
import { startVerifyServer, type RunningReview } from "../src/verify/serve";

setDefaultTimeout(60_000);

interface App {
	url: string;
	hits: { path: string; role: string; theme: string; state: string }[];
	stop(): void;
}

function startApp(kind: "before" | "after" | "target"): App {
	const hits: App["hits"] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const role = req.headers.get("x-seed-role") ?? "missing";
			const theme = url.searchParams.get("dg-theme") ?? "missing";
			const state = url.searchParams.get("dg-state") ?? "missing";
			hits.push({ path: url.pathname, role, theme, state });
			const field = kind === "after" && url.pathname === "/" ? `<input id="q">` : `<label for="q">Query</label><input id="q">`;
			const html = `<!doctype html><html lang="en" data-theme="${theme}" data-scrolled="${state === "scrolled" ? "true" : "false"}"><head><title>${kind} ${url.pathname}</title></head><body><h1>${kind}</h1><button type="button" data-verify-menu aria-expanded="${state === "menu" ? "true" : "false"}">Open menu</button>${field}</body></html>`;
			return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		hits,
		stop() {
			server.stop(true);
		},
	};
}

async function run(argv: string[]): Promise<{ code: number | undefined; out: string }> {
	const chunks: string[] = [];
	const original = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		return true;
	}) as typeof process.stdout.write;
	try {
		return { code: await main(argv), out: chunks.join("") };
	} finally {
		process.stdout.write = original;
	}
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("verify review", () => {
	const apps: App[] = [];
	let server: RunningReview | undefined;
	let dir = "";

	afterEach(() => {
		server?.stop();
		server = undefined;
		for (const app of apps) app.stop();
		apps.length = 0;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	test("captures round one, takes verdicts, and reruns only the follow-up as round two", async () => {
		const before = startApp("before");
		const after = startApp("after");
		const target = startApp("target");
		apps.push(before, after, target);
		dir = mkdtempSync(join(tmpdir(), "dg-verify-review-"));
		const roles = [
			{ id: "admin", headers: { "x-seed-role": "admin" } },
			{ id: "member", headers: { "x-seed-role": "member" } },
		];
		const manifestFile = join(dir, "input.json");
		writeFileSync(
			manifestFile,
			JSON.stringify({
				name: "review",
				stackUrl: `${after.url}/`,
				tests: { summary: "4 passed", passed: 4, failed: 0 },
				items: [
					{ id: "home", title: "Home", what: "New search field.", owner: "dg:implementer", afterRef: "feat/home", beforeUrl: `${before.url}/`, afterUrl: `${after.url}/`, targetUrl: `${target.url}/`, roles },
					{ id: "settings", title: "Settings", owner: "bc-owner", beforeUrl: `${before.url}/settings`, afterUrl: `${after.url}/settings`, roles },
				],
			}),
		);
		const flags = [`--dir=${dir}`, "--engine=http"];
		const captured = await run(["capture", "review", `--manifest=${manifestFile}`, ...flags]);
		expect(captured.code).toBe(0);
		expect(captured.out).toBe("added home-r1: 36 images\nadded settings-r1: 36 images\n");
		expect(before.hits.filter((hit) => hit.path === "/")).toHaveLength(36);
		expect(target.hits).toHaveLength(36);
		expect(before.hits.some((hit) => hit.role === "member" && hit.theme === "dark" && hit.state === "menu")).toBe(true);

		const paths = verifyPaths(dir);
		const board = readBoard(paths, "review");
		expect(board.pending).toEqual([]);
		const home = board.sections.find((section) => section.id === "home-r1") as Section;
		expect(home).toMatchObject({ title: "Home", round: 1, item: "home", branch: "feat/home", what_changed: "New search field." });
		expect(home.checks?.tests).toEqual({ status: "passed", summary: "4 passed" });
		expect(home.checks?.axe?.violations).toEqual(["label"]);
		expect(board.sections.find((section) => section.id === "settings-r1")?.checks?.axe?.violations).toEqual([]);
		expect(home.images.map((image) => image.label.split(" · ")[0])).toEqual(
			expect.arrayContaining(["desktop", "tablet", "mobile"]),
		);
		const tablet = home.images.find((image) => image.label === "tablet · admin · dark · scrolled · html fetch");
		expect(tablet).toEqual({
			label: "tablet · admin · dark · scrolled · html fetch",
			before: "/shots/home-r1/before/admin/tablet/dark/scrolled.png",
			after: "/shots/home-r1/after/admin/tablet/dark/scrolled.png",
			target: "/shots/home-r1/target/admin/tablet/dark/scrolled.png",
		});
		expect(board.sections.find((section) => section.id === "settings-r1")?.images[0]?.target).toBeUndefined();
		const homeShot = join(dir, "shots/home-r1/before/admin/desktop/light/default.png");
		const homeMtime = statSync(homeShot).mtimeMs;

		expect((await run(["status", "review", `--dir=${dir}`])).out).toBe(
			"· Home | r1 unreviewed\n· Settings | r1 unreviewed\n2 open\n",
		);
		expect((await run(["wait", "review", `--dir=${dir}`, "--timeout=0"])).code).toBe(1);

		server = await startVerifyServer({ name: "review", paths, port: 0 });
		const url = `http://127.0.0.1:${server.port}`;
		const verdicts = await fetch(`${url}/api/verdicts`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: url },
			body: JSON.stringify({ "home-r1": { status: "approved", note: "" }, "settings-r1": { status: "approved", note: "The menu clips on mobile" } }),
		});
		expect(verdicts.status).toBe(200);
		expect((await fetch(`${url}${tablet?.after}`)).status).toBe(200);

		const waited = await run(["wait", "review", `--dir=${dir}`, "--timeout=0"]);
		expect(waited.code).toBe(0);
		expect(waited.out).toBe("✓ Home | r1 approved\n· Settings | r1 approved+note | The menu clips on mobile\n1 open\n");

		const settingsHits = before.hits.filter((hit) => hit.path === "/settings").length;
		const homeHits = before.hits.filter((hit) => hit.path === "/").length;
		const rerun = await run(["rerun", "review", ...flags]);
		expect(rerun.out).toBe("added settings-r2: 36 images\n");
		expect(before.hits.filter((hit) => hit.path === "/settings").length).toBe(settingsHits + 36);
		expect(before.hits.filter((hit) => hit.path === "/").length).toBe(homeHits);
		expect(statSync(homeShot).mtimeMs).toBe(homeMtime);
		expect(existsSync(join(dir, "shots/settings-r1/after/admin/mobile/light/menu.png"))).toBe(true);
		const second = readBoard(paths, "review").sections.find((section) => section.id === "settings-r2");
		expect(second).toMatchObject({ follows: "settings-r1", round: 2, summary: "Rework: The menu clips on mobile" });
		expect((await run(["status", "review", `--dir=${dir}`, "--json"])).out).toContain('"rounds":["r1 approved+note","r2 unreviewed"]');
		expect((await run(["rerun", "review", ...flags])).out).toBe("nothing-to-recapture\n");
		expect((await run(["wait", "review", `--dir=${dir}`, "--timeout=0"])).out).toBe("timeout\n");
	});

	test("adds a hand-made round and an agent-working entry", async () => {
		dir = mkdtempSync(join(tmpdir(), "dg-verify-add-"));
		const shots = join(dir, "mine");
		Bun.spawnSync(["mkdir", "-p", shots]);
		writeFileSync(join(shots, "p-after-nav-390.png"), PNG);
		writeFileSync(join(shots, "p-before-nav-390.png"), PNG);
		writeFileSync(join(shots, "p-after-nav-1440.png"), PNG);
		const session = join(dir, "s");
		const added = await run(["add", "review", "nav-r1", "--title=Nav", "--summary=First pass", `--shots=${shots}`, "--prefix=p-", `--dir=${session}`]);
		expect(added.out).toBe("added nav-r1: 2 images (1 without before)\n");
		const board = readBoard(verifyPaths(session), "review");
		expect(board.sections[0]?.images).toEqual([
			{ label: "desktop · nav-1440", before: "missing", after: "/shots/nav-r1/added/p-after-nav-1440.png", reason: "no before captured" },
			{ label: "mobile · nav-390", before: "/shots/nav-r1/added/p-before-nav-390.png", after: "/shots/nav-r1/added/p-after-nav-390.png" },
		]);
		expect(readFileSync(join(session, "shots/nav-r1/added/p-after-nav-390.png"))).toEqual(Buffer.from(PNG));

		const waiting = await run(["pending", "add", "review", "nav-r2", "--title=Nav", "--detail=Fixing the gap", "--follows=nav-r1", `--dir=${session}`]);
		expect(waiting.out).toBe("pending add nav-r2: 1 open\n");
		expect((await run(["status", "review", `--dir=${session}`])).out).toBe("· Nav | r1 unreviewed → r2 working\n1 open\n");
		const second = await run(["add", "review", "nav-r2", "--title=Nav", "--follows=nav-r1", "--round=2", `--img=tablet · nav|missing|${join(shots, "p-after-nav-390.png")}|new`, `--dir=${session}`]);
		expect(second.out).toBe("added nav-r2: 1 images (1 without before)\n");
		expect(readBoard(verifyPaths(session), "review").pending).toEqual([]);
		expect((await run(["pending", "done", "review", "nav-r2", `--dir=${session}`])).out).toBe("pending done nav-r2: 0 open\n");
		expect((await run(["add", "review", "x-r1", "--title=X", `--img=a|missing|${join(dir, "nope.png")}`, `--dir=${session}`])).code).toBe(1);
		expect((await run(["add", "review", "x-r2", "--title=X", "--follows=gone", `--shots=${shots}`, "--prefix=p-", `--dir=${session}`])).code).toBe(1);
		expect((await run(["pending", "add", "review", "k", `--dir=${session}`])).code).toBe(1);
	});

	test("help lists every command, a missing name fails, and sessions stay out of git", async () => {
		const help = await run(["--help"]);
		expect(help.code).toBe(0);
		for (const command of ["serve", "status", "add", "pending", "watch", "wait", "stop", "capture", "rerun"])
			expect(help.out).toContain(`  ${command} `);
		expect((await run(["status"])).code).toBe(1);
		dir = mkdtempSync(join(tmpdir(), "dg-verify-missing-"));
		expect((await run(["capture", "review", `--dir=${dir}`])).code).toBe(1);
		expect((await run(["stop", "review", `--dir=${dir}`])).out).toBe("not running review\n");
		const repo = join(import.meta.dir, "../../..");
		expect(Bun.spawnSync(["git", "check-ignore", "-q", ".agents/verify/demo/shots/a.png"], { cwd: repo }).exitCode).toBe(0);
	});
});
