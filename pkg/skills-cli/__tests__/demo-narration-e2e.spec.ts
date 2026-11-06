import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { runPlayer } from "../src/demo/player-process";
import type { DemoResult } from "../src/demo/result";

const enabled =
	process.env.PW_E2E === "1" && process.env.DG_NARRATION_E2E === "1";

describe.skipIf(!enabled)(
	"player --video --narration both against a local http server",
	() => {
		let dir: string;
		let server: ReturnType<typeof Bun.serve>;
		let packed: string;
		const previousHome = process.env.DG_HOME;
		const releaseFetch = (async (input: unknown) => {
			const url = String(input instanceof Request ? input.url : input);
			const file = join(packed, url.slice(url.lastIndexOf("/") + 1));
			if (!url.includes("/releases/download/") || !existsSync(file))
				return new Response("missing", { status: 404 });
			return new Response(new Blob([readFileSync(file)]));
		}) as unknown as typeof fetch;

		beforeAll(() => {
			dir = mkdtempSync(join(tmpdir(), "dg-narration-e2e-"));
			packed = join(dir, "packed");
			const pack = Bun.spawnSync(
				[
					"bun",
					"run",
					join(
						import.meta.dir,
						"..",
						"..",
						"..",
						"scripts",
						"pack-narration-assets.ts",
					),
					"--out",
					packed,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			if (pack.exitCode !== 0) throw new Error(pack.stderr.toString());
			expect(
				existsSync(join(packed, `dg-demo-narration-${pkg.version}.zip`)),
			).toBe(true);
			process.env.DG_HOME = join(dir, "dg-home");
			server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: () =>
					new Response('<!doctype html><h1 id="one">One</h1>', {
						headers: { "content-type": "text/html" },
					}),
			});
		});
		afterAll(() => {
			server.stop(true);
			if (previousHome === undefined) delete process.env.DG_HOME;
			else process.env.DG_HOME = previousHome;
			rmSync(dir, { recursive: true, force: true });
		});

		test("produces a webm with an audio stream, or a sidecar wav when ffmpeg is missing", async () => {
			const slug = "narrated-e2e";
			const startUrl = `http://127.0.0.1:${server.port}/`;
			const planPath = join(dir, `${slug}.demo.md`);
			writeFileSync(planPath, "");
			await runPlayer(
				{
					slug,
					planPath,
					dir,
					video: true,
					narration: "both",
					profile: join(dir, "profile"),
					startUrl,
					script: {
						title: "Narrated E2E",
						startUrl,
						mode: "video" as const,
						steps: [
							{
								title: "First stop",
								body: "Hello from the narrated tour.",
								selector: "#one",
							},
						],
					},
				},
				{ fetch: releaseFetch },
			);
			const result = JSON.parse(
				readFileSync(join(dir, `${slug}.result.json`), "utf8"),
			) as DemoResult & { audio: "muxed" | "sidecar" | "none" };
			expect(result.outcome).toBe("done");
			expect(result.audio).not.toBe("none");
			const files = readdirSync(dir);
			const webm = files.find((name) =>
				/^narrated-e2e-\d{8}-\d{4}\.webm$/.test(name),
			);
			expect(webm).toBeDefined();
			if (result.audio === "muxed") {
				const probe = Bun.spawnSync(
					[
						"ffprobe",
						"-v",
						"error",
						"-select_streams",
						"a",
						"-show_entries",
						"stream=codec_name",
						"-of",
						"csv=p=0",
						join(dir, webm as string),
					],
					{ stdout: "pipe" },
				);
				expect(probe.stdout.toString().trim().length).toBeGreaterThan(0);
				expect(files.some((name) => name.endsWith(".wav"))).toBe(false);
			} else {
				const wav = files.find((name) => name.endsWith(".wav"));
				expect(wav).toBeDefined();
				expect(existsSync(join(dir, wav as string))).toBe(true);
			}
		}, 600_000);
	},
);
