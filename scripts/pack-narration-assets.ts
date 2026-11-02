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
import { deflateRawSync } from "node:zlib";
import { NARRATION_ASSET_BASE, narrationZipName } from "../pkg/common/src/narration";

const ROOT = resolve(import.meta.dir, "..");
const ORT_FILES = [
	"ort-wasm-simd-threaded.jsep.mjs",
	"ort-wasm-simd-threaded.jsep.wasm",
] as const;
const DOS_DATE_1980 = 0x21;

type Entry = { name: string; data: Uint8Array };

const u16 = (value: number): Buffer => {
	const out = Buffer.alloc(2);
	out.writeUInt16LE(value);
	return out;
};
const u32 = (value: number): Buffer => {
	const out = Buffer.alloc(4);
	out.writeUInt32LE(value >>> 0);
	return out;
};

/** A zip with fixed timestamps, so the same inputs give the same bytes. */
export function zipEntries(entries: Entry[]): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const nameBytes = Buffer.from(name);
		const packed = deflateRawSync(data);
		const crc = Bun.hash.crc32(data) >>> 0;
		const shared = [
			u16(20),
			u16(0x0800),
			u16(8),
			u16(0),
			u16(DOS_DATE_1980),
			u32(crc),
			u32(packed.length),
			u32(data.length),
			u16(nameBytes.length),
			u16(0),
		];
		const local = Buffer.concat([u32(0x04034b50), ...shared, nameBytes]);
		parts.push(local, packed);
		central.push(
			Buffer.concat([
				u32(0x02014b50),
				u16(20),
				...shared,
				u16(0),
				u16(0),
				u16(0),
				u32(0),
				u32(offset),
				nameBytes,
			]),
		);
		offset += local.length + packed.length;
	}
	const directory = Buffer.concat(central);
	return Buffer.concat([
		...parts,
		directory,
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(entries.length),
		u16(entries.length),
		u32(directory.length),
		u32(offset),
		u16(0),
	]);
}

function transformersDist(): string {
	const require = createRequire(import.meta.url);
	const kokoro = dirname(require.resolve("kokoro-js/package.json"));
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
	const require = createRequire(import.meta.url);
	const web = join(
		dirname(require.resolve("kokoro-js/package.json")),
		"dist",
		"kokoro.web.js",
	);
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
	const entries: Entry[] = [
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
