import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NARRATION_ASSET_BASE, narrationZipName } from "../pkg/common/src/narration";
import { type ZipEntry, zipEntries } from "./zip";

const ROOT = resolve(import.meta.dir, "..");
const ORT_FILES = [
	"ort-wasm-simd-threaded.jsep.mjs",
	"ort-wasm-simd-threaded.jsep.wasm",
] as const;

/** Resolves kokoro-js from the extension package that declares it, so hoisted and isolated installs both work. */
export function kokoroDir(root: string = ROOT): string {
	const require = createRequire(join(root, "pkg", "extension", "package.json"));
	return dirname(require.resolve("kokoro-js/package.json"));
}

function transformersDist(): string {
	const kokoro = kokoroDir();
	const require = createRequire(join(kokoro, "package.json"));
	for (const candidate of [
		join(kokoro, "node_modules", "@huggingface", "transformers", "dist"),
		join(
			dirname(require.resolve("@huggingface/transformers/package.json")),
			"dist",
		),
	]) {
		if (existsSync(join(candidate, ORT_FILES[0]))) return candidate;
	}
	throw new Error("cannot find @huggingface/transformers/dist; run bun install");
}

/** Hugging Face commit of onnx-community/Kokoro-82M-v1.0-ONNX that narration loads. */
export const KOKORO_MODEL_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";

const MODEL_PATH_TEMPLATE = '"{model}/resolve/{revision}/"';

const VOICES_PATH = "/resolve/main/voices/";

const EXPORT_LIST = /export\s*\{([^}]*)\}\s*;?\s*$/;

/** kokoro.web.js as a classic script that sets globalThis.__dgKokoro. */
export function kokoroIife(source: string): string {
	const exported = EXPORT_LIST.exec(source);
	if (!exported?.[1]) throw new Error("kokoro.web.js has no export list");
	const members = exported[1].split(",").map((item) => {
		const [local, , name] = item.trim().split(/\s+/);
		if (!local) throw new Error(`unreadable export: ${item}`);
		return `${name ?? local}:${local}`;
	});
	const sliced = source.slice(0, exported.index);
	if (!sliced.includes(MODEL_PATH_TEMPLATE))
		throw new Error("kokoro.web.js has no model path template to pin");
	const body = sliced
		.replaceAll(MODEL_PATH_TEMPLATE, JSON.stringify(`{model}/resolve/${KOKORO_MODEL_REVISION}/`))
		.replaceAll(VOICES_PATH, `/resolve/${KOKORO_MODEL_REVISION}/voices/`)
		.replaceAll("import.meta", "__dgImportMeta");
	if (body.includes("/resolve/main/"))
		throw new Error("kokoro.web.js still loads from the main branch");
	const meta = `{url:${JSON.stringify(`${NARRATION_ASSET_BASE}kokoro.js`)}}`;
	if (/^\s*import[\s{*"']/m.test(body))
		throw new Error("kokoro.web.js still has a static import");
	const script = `(async()=>{const __dgImportMeta=${meta};${body};globalThis.__dgKokoro={${members.join(",")}};})();\n`;
	new Function(script);
	return script;
}

function kokoroSource(): Uint8Array {
	const web = join(kokoroDir(), "dist", "kokoro.web.js");
	return new TextEncoder().encode(kokoroIife(readFileSync(web, "utf8")));
}

function main(): void {
	const { values } = parseArgs({
		options: { out: { type: "string" } },
		strict: true,
	});
	if (!values.out) throw new Error("usage: pack-narration-assets.ts --out <dir>");
	const out = resolve(values.out);
	const { version } = JSON.parse(
		readFileSync(join(ROOT, "pkg", "skills-cli", "package.json"), "utf8"),
	) as { version: string };
	const dist = transformersDist();
	const entries: ZipEntry[] = [
		{ name: "kokoro.js", data: kokoroSource() },
		...ORT_FILES.map((file) => ({
			name: `ort/${file}`,
			data: new Uint8Array(readFileSync(join(dist, file))),
		})),
	];
	const name = narrationZipName(version);
	const zip = zipEntries(entries);
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, name), zip);
	const digest = createHash("sha256").update(zip).digest("hex");
	writeFileSync(join(out, "SHA256SUMS"), `${digest}  ${name}\n`);
}

if (import.meta.main) main();
