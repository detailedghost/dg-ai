import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { narrationZipName, sha256 } from "./demo-narration-fixtures";

const ROOT = new URL("../../..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "scripts", "pack-narration-assets.ts");
const PACKAGE_JSON = join(ROOT, "pkg", "skills-cli", "package.json");

let out: string;
beforeEach(() => {
	out = mkdtempSync(join(tmpdir(), "dg-pack-narration-"));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

const version = (): string =>
	(JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string }).version;

function pack(): { exitCode: number; stderr: string } {
	const run = Bun.spawnSync(["bun", "run", SCRIPT, "--out", out], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: run.exitCode, stderr: run.stderr.toString() };
}

describe("pack-narration-assets script", () => {
	test("writes the versioned narration zip into the out dir", () => {
		const run = pack();
		expect(run.stderr).toBe("");
		expect(run.exitCode).toBe(0);
		expect(readdirSync(out)).toContain(narrationZipName(version()));
	}, 180_000);

	test("lists the zip in SHA256SUMS with the zip's real SHA-256 in sha256sum format", () => {
		expect(pack().exitCode).toBe(0);
		const name = narrationZipName(version());
		const sums = readFileSync(join(out, "SHA256SUMS"), "utf8");
		const digest = sha256(new Uint8Array(readFileSync(join(out, name))));
		expect(sums.split("\n")).toContain(`${digest}  ${name}`);
	}, 180_000);

	test("puts the ONNX Runtime wasm and its loader under ort/ in the zip", () => {
		expect(pack().exitCode).toBe(0);
		const listing = Bun.spawnSync(
			["unzip", "-Z1", join(out, narrationZipName(version()))],
			{ stdout: "pipe" },
		)
			.stdout.toString()
			.split("\n");
		expect(listing).toContain("ort/ort-wasm-simd-threaded.jsep.wasm");
		expect(listing).toContain("ort/ort-wasm-simd-threaded.jsep.mjs");
	}, 180_000);

	test("packs a kokoro.js that loads the model and voices from the pinned commit only", async () => {
		const { KOKORO_MODEL_REVISION } = await import("../../../scripts/pack-narration-assets");
		expect(pack().exitCode).toBe(0);
		const zip = join(out, narrationZipName(version()));
		const listing = Bun.spawnSync(["unzip", "-Z1", zip], { stdout: "pipe" })
			.stdout.toString()
			.split("\n");
		const entry = listing.find((name) => name.endsWith("kokoro.js"));
		expect(entry).toBeDefined();
		const script = Bun.spawnSync(["unzip", "-p", zip, entry ?? ""], {
			stdout: "pipe",
		}).stdout.toString();
		expect(script).toContain(KOKORO_MODEL_REVISION);
		expect(script).not.toContain("/resolve/main/");
	}, 180_000);
});

const VOICES = 'const url = `https://huggingface.co/x/y/resolve/main/voices/${id}.bin`;\n';
const TEMPLATE = 'const env = { remotePathTemplate: "{model}/resolve/{revision}/" };\n';

describe("kokoroIife", () => {
	test("rejects a source that still has a static import", async () => {
		const { kokoroIife } = await import("../../../scripts/pack-narration-assets");
		expect(() => kokoroIife(`import x from "y";\n${TEMPLATE}const a = 1;\nexport { a };`)).toThrow(
			"static import",
		);
	});

	test("rejects a source that does not parse", async () => {
		const { kokoroIife } = await import("../../../scripts/pack-narration-assets");
		expect(() => kokoroIife(`${TEMPLATE}const = ;\nexport { a };`)).toThrow();
	});

	test("wraps a clean module so it parses and exposes its exports", async () => {
		const { kokoroIife } = await import("../../../scripts/pack-narration-assets");
		expect(kokoroIife(`${TEMPLATE}const a = 1;\nexport { a as KokoroTTS };`)).toContain(
			"KokoroTTS:a",
		);
	});

	test("pins the model download to a fixed Hugging Face commit", async () => {
		const { kokoroIife, KOKORO_MODEL_REVISION } = await import("../../../scripts/pack-narration-assets");
		const script = kokoroIife(`${TEMPLATE}const a = 1;\nexport { a as KokoroTTS };`);
		expect(KOKORO_MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
		expect(script).toContain(`{model}/resolve/${KOKORO_MODEL_REVISION}/`);
		expect(script).not.toContain("{revision}");
	});

	test("pins the voice downloads to the same commit", async () => {
		const { kokoroIife, KOKORO_MODEL_REVISION } = await import("../../../scripts/pack-narration-assets");
		const script = kokoroIife(`${TEMPLATE}${VOICES}export { a as KokoroTTS };`);
		expect(script).toContain(`/resolve/${KOKORO_MODEL_REVISION}/voices/`);
		expect(script).not.toContain("resolve/main");
	});

	test("refuses a source that still loads from the main branch", async () => {
		const { kokoroIife } = await import("../../../scripts/pack-narration-assets");
		expect(() =>
			kokoroIife(`${TEMPLATE}const u = "https://h/x/resolve/main/config.json";\nexport { a as KokoroTTS };`),
		).toThrow("main branch");
	});

	test("refuses a source with no model path template", async () => {
		const { kokoroIife } = await import("../../../scripts/pack-narration-assets");
		expect(() => kokoroIife("const a = 1;\nexport { a as KokoroTTS };")).toThrow("model path template");
	});
});

describe("kokoroDir", () => {
	test("finds kokoro-js under the extension package when the root has no copy", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync: write, realpathSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join: j } = await import("node:path");
		const { kokoroDir } = await import("../../../scripts/pack-narration-assets");
		const root = realpathSync(mkdtempSync(j(tmpdir(), "dg-kokoro-")));
		const ext = j(root, "pkg", "extension");
		const pkg = j(ext, "node_modules", "kokoro-js");
		mkdirSync(pkg, { recursive: true });
		write(j(ext, "package.json"), JSON.stringify({ name: "ext" }));
		write(j(pkg, "package.json"), JSON.stringify({ name: "kokoro-js", version: "1.0.0" }));
		expect(kokoroDir(root)).toBe(pkg);
	});
});
