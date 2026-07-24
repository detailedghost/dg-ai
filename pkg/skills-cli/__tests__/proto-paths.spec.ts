import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateStyleGuide } from "@dg/common";
import {
	normalizeColor,
	styleGuideFromSamples,
} from "../../extension/lib/features/prototype";
import {
	dgProtoPath,
	pollForFile,
	protoScratchPath,
	protoSlug,
	resolveDownloadsDir,
} from "../src/utils/proto-paths";

const temporaryDirectories: string[] = [];
const skillsCliRoot = join(import.meta.dir, "..");
const skillsCliEntry = join(skillsCliRoot, "src", "index.ts");

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "dg-proto-paths-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

function buildRawSamples() {
	return {
		meta: {
			url: "https://example.test/account",
			scrapedAt: 1_721_234_567_890,
			sameOrigin: true,
		},
		customProps: { "--z-index": "10", "--brand": "#111111" },
		colors: ["#ffffff", "#111111", "#111111", "#00aaff", "#ffffff", "#111111"],
		fontStacks: ["Inter, sans-serif", "Inter, sans-serif"],
		typeScale: ["14px", "16px", "16px", "24px"],
		spacing: ["8px", "4px", "16px", "8px", "4px"],
		radii: ["8px", "4px", "8px", "4px"],
		shadows: [
			"0 1px 2px rgb(0 0 0 / 0.1)",
			"0 2px 8px rgb(0 0 0 / 0.15)",
			"0 1px 2px rgb(0 0 0 / 0.1)",
		],
		components: {
			button: { "z-index": "1", background: "#111111" },
			input: { color: "#111111", border: "1px solid #111111" },
			link: { "font-weight": "600", color: "#00aaff" },
		},
	};
}

async function executable(path: string, source: string): Promise<void> {
	await writeFile(path, source);
	await chmod(path, 0o755);
}

type CliResult = {
	code: number | null;
	stdout: string;
	stderr: string;
	elapsedMs: number;
};

async function runCli(
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<CliResult> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [skillsCliEntry, ...args], {
			cwd: skillsCliRoot,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				elapsedMs: Date.now() - startedAt,
			});
		});
	});
}

async function cliHarness(styleGuideJson = "") {
	const directory = await temporaryDirectory();
	const bin = join(directory, "bin");
	const downloads = join(directory, "downloads");
	const home = join(directory, "home");
	const scratch = join(directory, "scratch");
	await Promise.all([
		mkdir(bin, { recursive: true }),
		mkdir(downloads, { recursive: true }),
		mkdir(home, { recursive: true }),
	]);
	await executable(
		join(bin, "xdg-user-dir"),
		'#!/bin/sh\nprintf "%s\\n" "$DG_TEST_DOWNLOADS"\n',
	);
	const opener = [
		"#!/bin/sh",
		'if [ "${DG_REQUIRE_STALE_REMOVED:-0}" = "1" ] && { [ -e "$DG_TEST_EXPECTED" ] || [ -e "$DG_TEST_EXPECTED.crdownload" ]; }; then',
		"  exit 41",
		"fi",
		'if [ -n "${DG_TEST_GUIDE:-}" ]; then',
		'  mkdir -p "$(dirname "$DG_TEST_EXPECTED")"',
		'  printf "%s" "$DG_TEST_GUIDE" > "$DG_TEST_EXPECTED"',
		"fi",
		"exit 0",
		"",
	].join("\n");
	await Promise.all([
		executable(join(bin, "xdg-open"), opener),
		executable(join(bin, "wslview"), opener),
		executable(
			join(bin, "cmd.exe"),
			'#!/bin/sh\nprintf "%s\\n" "C:\\\\Users\\\\Ada"\n',
		),
		executable(
			join(bin, "wslpath"),
			'#!/bin/sh\nprintf "%s\\n" "$DG_TEST_DOWNLOADS"\n',
		),
	]);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		AI_SCRATCH_DIR: scratch,
		DG_TEST_DOWNLOADS: downloads,
		DG_TEST_GUIDE: styleGuideJson,
		PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
		WSL_DISTRO_NAME: "",
	};
	return { directory, downloads, home, scratch, env };
}

describe("prototype paths", () => {
	test("builds stable relative, scratch, and collision-resistant URL paths", () => {
		const firstUrl = "https://example.test/account/summary";
		const secondUrl = "https://example.test/account/settings";
		const firstSlug = protoSlug(firstUrl);

		expect(protoSlug(firstUrl)).toBe(firstSlug);
		expect(firstSlug).toMatch(/^example-test-account-summary-[a-f0-9]{8}$/);
		expect(protoSlug(secondUrl)).not.toBe(firstSlug);
		expect(protoSlug(`${firstUrl}?view=compact`)).not.toBe(firstSlug);
		expect(
			protoSlug(`https://example.test/${"nested-path/".repeat(40)}`),
		).toMatch(/^[a-z0-9][a-z0-9_-]{0,127}$/);
		expect(dgProtoPath(firstSlug, "style-guide.json")).toBe(
			`dg-proto/${firstSlug}/style-guide.json`,
		);
		expect(
			protoScratchPath(firstSlug, "style-guide.json", {
				env: { AI_SCRATCH_DIR: "/agent-scratch" },
				homeDir: "/home/ada",
			}),
		).toBe(join("/agent-scratch", "proto", firstSlug, "style-guide.json"));
		expect(
			protoScratchPath(firstSlug, "style-guide.json", {
				env: {},
				homeDir: "/home/ada",
			}),
		).toBe(join("/home/ada", ".dg", "proto", firstSlug, "style-guide.json"));
	});

	test("resolves platform download directories through injectable system seams", () => {
		const unexpectedRun = () => {
			throw new Error("run must not be called for this platform");
		};

		expect(
			resolveDownloadsDir({
				platform: "linux",
				homeDir: "/home/ada",
				isWSL: () => false,
				run: unexpectedRun,
			}),
		).toBe("/home/ada/Downloads");
		expect(
			resolveDownloadsDir({
				platform: "linux",
				homeDir: "/home/ada",
				isWSL: () => false,
				run(command, args) {
					expect([command, ...args]).toEqual(["xdg-user-dir", "DOWNLOAD"]);
					return "/srv/downloads\n";
				},
			}),
		).toBe("/srv/downloads");
		expect(
			resolveDownloadsDir({
				platform: "linux",
				homeDir: "/home/ada",
				isWSL: () => false,
				run: () => "   ",
			}),
		).toBe("/home/ada/Downloads");
		expect(
			resolveDownloadsDir({
				platform: "darwin",
				homeDir: "/Users/ada",
				isWSL: () => false,
				run: unexpectedRun,
			}),
		).toBe("/Users/ada/Downloads");
		expect(
			resolveDownloadsDir({
				platform: "win32",
				homeDir: "C:\\Users\\Ada",
				isWSL: () => false,
				run: unexpectedRun,
			}),
		).toBe("C:\\Users\\Ada\\Downloads");

		const commands: string[] = [];
		expect(
			resolveDownloadsDir({
				platform: "linux",
				homeDir: "/home/ada",
				isWSL: () => true,
				run(command, args) {
					commands.push(command);
					if (command === "cmd.exe") return "C:\\Users\\Ada";
					if (command === "wslpath") {
						expect(args).toEqual(["-u", "C:\\Users\\Ada\\Downloads"]);
						return "/mnt/c/Users/Ada/Downloads";
					}
					throw new Error(`unexpected command: ${command}`);
				},
			}),
		).toBe("/mnt/c/Users/Ada/Downloads");
		expect(commands).toEqual(["cmd.exe", "wslpath"]);
	});
});

describe("pollForFile", () => {
	test("resolves parsed JSON after a real file arrives", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "style-guide.json");
		const expected = { ready: true, source: "browser" };
		const writer = new Promise<void>((resolve, reject) => {
			setTimeout(() => {
				writeFile(path, JSON.stringify(expected)).then(resolve, reject);
			}, 40);
		});

		const received = await pollForFile(path, {
			timeoutMs: 200,
			intervalMs: 20,
		});
		await writer;

		expect(received).toEqual(expected);
	});

	test("waits through a partial download and transient malformed JSON", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "style-guide.json");
		const partialPath = `${path}.crdownload`;
		const expected = { ready: true, attempts: 2 };
		await writeFile(path, '{"ready":');
		const writer = new Promise<void>((resolve, reject) => {
			setTimeout(() => {
				Promise.all([
					writeFile(path, JSON.stringify({ ready: false, attempts: 1 })),
					writeFile(partialPath, "partial browser download"),
				]).then(() => {
					setTimeout(() => {
						Promise.all([
							writeFile(path, JSON.stringify(expected)),
							unlink(partialPath),
						]).then(() => resolve(), reject);
					}, 40);
				}, reject);
			}, 30);
		});

		const received = await pollForFile(path, {
			timeoutMs: 250,
			intervalMs: 20,
		});
		await writer;

		expect(received).toEqual(expected);
	});

	test("times out with every fixed-path breaker in the error", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "style-guide.json");

		try {
			await pollForFile(path, { timeoutMs: 60, intervalMs: 10 });
			throw new Error("pollForFile unexpectedly resolved");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toMatch(/relocated Downloads dir/i);
			expect(message).toMatch(/ask where to save each file/i);
			expect(message).toMatch(/Linux-side browser/i);
		}
	});
});

describe("styleGuideFromSamples", () => {
	test("frequency-ranks colors and deterministically quantizes repeated tokens", () => {
		const raw = buildRawSamples();

		const first = styleGuideFromSamples(raw);
		const second = styleGuideFromSamples(structuredClone(raw));

		expect(validateStyleGuide(first)).toBe(first);
		expect(second).toEqual(first);
		expect(first.tokens.colors).toEqual([
			"rgb(17, 17, 17)",
			"rgb(255, 255, 255)",
			"rgb(0, 170, 255)",
		]);
		expect(first.tokens.spacing).toEqual(["4px", "8px", "16px"]);
		expect(first.tokens.radii).toEqual(["4px", "8px"]);
		expect(first.tokens.shadows).toEqual([
			"0 1px 2px rgb(0 0 0 / 0.1)",
			"0 2px 8px rgb(0 0 0 / 0.15)",
		]);
		expect(Object.keys(first.tokens.customProps)).toEqual([
			"--brand",
			"--z-index",
		]);
		expect(Object.keys(first.components.button)).toEqual([
			"background",
			"z-index",
		]);
		expect(Object.keys(first.components.input)).toEqual(["border", "color"]);
	});

	test("normalizes equivalent colors and uses first occurrence as the tie-break", () => {
		const raw = buildRawSamples();
		raw.colors = [
			"#fff",
			"rgb(0 0 0)",
			"rgb(255, 255, 255)",
			"#000000",
			"rgba(255 255 255 / 100%)",
			"transparent",
			"rgba(0, 0, 0, 0)",
		];

		const guide = styleGuideFromSamples(raw);

		expect(normalizeColor("#0af8")).toBe("rgba(0, 170, 255, 0.533)");
		expect(guide.tokens.colors).toEqual([
			"rgb(255, 255, 255)",
			"rgb(0, 0, 0)",
			"rgba(0, 0, 0, 0)",
		]);
	});
});

describe("proto scrape command", () => {
	test("deletes stale downloads before opening and copies a validated guide", async () => {
		const styleGuide = styleGuideFromSamples(buildRawSamples());
		const harness = await cliHarness(JSON.stringify(styleGuide));
		const url = "https://example.test/account";
		const slug = protoSlug(url);
		const expectedDownload = join(
			harness.downloads,
			dgProtoPath(slug, "style-guide.json"),
		);
		const expectedScratch = protoScratchPath(slug, "style-guide.json", {
			env: { AI_SCRATCH_DIR: harness.scratch },
			homeDir: harness.home,
		});
		await mkdir(join(expectedDownload, ".."), { recursive: true });
		await Promise.all([
			writeFile(expectedDownload, '{"stale":true}'),
			writeFile(`${expectedDownload}.crdownload`, "stale partial"),
		]);

		const result = await runCli(["proto", "scrape", url, "--timeout", "500"], {
			...harness.env,
			DG_REQUIRE_STALE_REMOVED: "1",
			DG_TEST_EXPECTED: expectedDownload,
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(expectedScratch);
		expect(JSON.parse(await readFile(expectedScratch, "utf8"))).toEqual(
			styleGuide,
		);
	});

	test("rejects an invalid download before creating the scratch copy", async () => {
		const harness = await cliHarness('{"ready":true}');
		const url = "https://example.test/invalid-guide";
		const slug = protoSlug(url);
		const expectedDownload = join(
			harness.downloads,
			dgProtoPath(slug, "style-guide.json"),
		);
		const expectedScratch = protoScratchPath(slug, "style-guide.json", {
			env: { AI_SCRATCH_DIR: harness.scratch },
			homeDir: harness.home,
		});

		const result = await runCli(["proto", "scrape", url, "--timeout", "500"], {
			...harness.env,
			DG_TEST_EXPECTED: expectedDownload,
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/Invalid style guide downloaded/i);
		await expect(readFile(expectedScratch, "utf8")).rejects.toThrow();
	});

	test("honors the timeout override and reports every fixed-path breaker", async () => {
		const harness = await cliHarness();
		const url = "https://example.test/no-download";
		const expectedDownload = join(
			harness.downloads,
			dgProtoPath(protoSlug(url), "style-guide.json"),
		);

		const result = await runCli(["proto", "scrape", url, "--timeout", "60"], {
			...harness.env,
			DG_TEST_EXPECTED: expectedDownload,
		});

		expect(result.code).toBe(1);
		expect(result.elapsedMs).toBeLessThan(2_000);
		expect(result.stderr).toMatch(/relocated Downloads dir/i);
		expect(result.stderr).toMatch(/ask where to save each file/i);
		expect(result.stderr).toMatch(/Linux-side browser/i);
	});
});
