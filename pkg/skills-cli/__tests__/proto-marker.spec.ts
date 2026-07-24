import "./compression-stream-shim";
import { describe, expect, test } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	PROTO_ENCODED_MAX_LENGTH,
	PROTO_EXPANDED_MAX_BYTES,
	PROTO_MAX_MARKUP_CHARS,
	PROTO_MAX_VARIATIONS,
	readProtoPayload,
	stripProtoMarker,
} from "../../extension/utils/proto-marker";
import {
	addProtoMarker,
	PROTO_URL_MAX_LENGTH,
	type ProtoPayload,
	protoPayloadFits,
} from "../src/utils/proto-marker";

function buildPlantPayload(): Extract<ProtoPayload, { phase: "plant" }> {
	return {
		phase: "plant",
		slug: "account-summary",
		plan: {
			slug: "account-summary",
			question: "¿Cuál diseño funciona mejor? 🌱 账户",
			mountSelector: "#app",
			mode: "replace",
			variations: [
				{
					key: "compact",
					label: "Résumé compact — コンパクト",
					html: "<main><h1>账户概览 🚀</h1></main>",
					css: '.summary::after { content: "✓"; }',
				},
			],
		},
	};
}

function directMarker(encoded: string): string {
	return `https://example.test/account#_proto=${encoded}`;
}

function gzipMarker(value: unknown): string {
	return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString(
		"base64url",
	);
}

function deterministicNoise(length: number): string {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const output = new Array<string>(length);
	let state = 0x6d2b79f5;
	for (let index = 0; index < length; index += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		output[index] = alphabet[(state >>> 0) % alphabet.length];
	}
	return output.join("");
}

describe("prototype URL marker", () => {
	test("round-trips a non-ASCII plant plan through gzip and base64url", async () => {
		const payload = buildPlantPayload();
		const marked = addProtoMarker("https://example.test/account", payload);
		const markedUrl = new URL(marked);
		const encoded = new URLSearchParams(markedUrl.hash.slice(1)).get("_proto");

		expect(markedUrl.searchParams.has("_proto")).toBe(false);
		expect(encoded).not.toBeNull();
		expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(gunzipSync(Buffer.from(encoded!, "base64url"))).toEqual(
			Buffer.from(JSON.stringify(payload), "utf8"),
		);
		expect(await readProtoPayload(marked)).toEqual(payload);
	});

	test("uses the same gzip path for scrape payloads", async () => {
		const payload = { phase: "scrape", slug: "account-summary" } as const;
		const marked = addProtoMarker("https://example.test/account", payload);
		const encoded = new URLSearchParams(new URL(marked).hash.slice(1)).get(
			"_proto",
		);

		expect(
			gunzipSync(Buffer.from(encoded!, "base64url")).toString("utf8"),
		).toBe(JSON.stringify(payload));
		expect(await readProtoPayload(marked)).toEqual(payload);
	});

	test("includes the complete marked URL at the exact size ceiling", () => {
		const payload = buildPlantPayload();
		const prefix = "https://example.test/";
		const markerLength = addProtoMarker("", payload).length;
		const exactBase =
			prefix + "x".repeat(PROTO_URL_MAX_LENGTH - markerLength - prefix.length);
		const oversizedBase = `${exactBase}x`;

		expect(addProtoMarker(exactBase, payload)).toHaveLength(
			PROTO_URL_MAX_LENGTH,
		);
		expect(protoPayloadFits(exactBase, payload)).toBe(true);
		expect(protoPayloadFits(oversizedBase, payload)).toBe(false);
		expect(() => addProtoMarker(oversizedBase, payload)).toThrow(
			/trim your variations/i,
		);
	});

	test("removes only the prototype marker from an existing fragment", async () => {
		const original =
			"https://example.test/account#tab=activity&_proto_backup=keep&anchor=summary";
		const marked = addProtoMarker(original, buildPlantPayload());

		expect(await readProtoPayload(marked)).toEqual(buildPlantPayload());
		expect(stripProtoMarker(marked)).toBe(original);
	});

	test("replaces a stale marker while preserving unrelated and marker-like entries", async () => {
		const base = "https://example.test/account#tab=activity&_proto_backup=keep";
		const stale = addProtoMarker(base, {
			phase: "scrape",
			slug: "account-summary",
		});
		const newestPayload = buildPlantPayload();
		const newest = addProtoMarker(stale, newestPayload);
		const exactMarkers = newest
			.slice(newest.indexOf("#") + 1)
			.split("&")
			.filter((entry) => entry.split("=", 1)[0] === "_proto");

		expect(exactMarkers).toHaveLength(1);
		expect(await readProtoPayload(newest)).toEqual(newestPayload);
		expect(stripProtoMarker(newest)).toBe(base);
	});

	test("replaces malformed existing markers before sizing and encoding", async () => {
		const base = "https://example.test/account#tab=activity&_proto_backup=keep";
		const malformed = `${base}&_proto=${"x".repeat(PROTO_URL_MAX_LENGTH)}`;
		const payload = buildPlantPayload();

		expect(protoPayloadFits(malformed, payload)).toBe(true);
		const marked = addProtoMarker(malformed, payload);
		expect(marked).not.toContain(`_proto=${"x".repeat(128)}`);
		expect(await readProtoPayload(marked)).toEqual(payload);
		expect(stripProtoMarker(marked)).toBe(base);
	});

	test("removes a marker-only fragment and ignores marker-like keys", async () => {
		const base = "https://example.test/account";
		const markerLike = `${base}#_proto_backup=keep`;

		expect(stripProtoMarker(addProtoMarker(base, buildPlantPayload()))).toBe(
			base,
		);
		expect(stripProtoMarker(markerLike)).toBe(markerLike);
		expect(await readProtoPayload(markerLike)).toBeUndefined();
	});

	test("returns undefined for malformed encodings and payloads", async () => {
		const validPlant = buildPlantPayload();
		const malformedMarkers = [
			"%%%",
			Buffer.from("not gzip", "utf8").toString("base64url"),
			gzipSync(Buffer.from("{", "utf8")).toString("base64url"),
			gzipSync(
				Buffer.from(JSON.stringify({ phase: "scrape", slug: "" }), "utf8"),
			).toString("base64url"),
			gzipSync(
				Buffer.from(
					JSON.stringify({ phase: "scrape", slug: "../escape" }),
					"utf8",
				),
			).toString("base64url"),
			gzipSync(
				Buffer.from(
					JSON.stringify({
						phase: "plant",
						slug: validPlant.slug,
						plan: [],
					}),
					"utf8",
				),
			).toString("base64url"),
			gzipSync(
				Buffer.from(
					JSON.stringify({
						phase: "plant",
						slug: validPlant.slug,
						plan: {},
					}),
					"utf8",
				),
			).toString("base64url"),
			gzipSync(
				Buffer.from(
					JSON.stringify({
						...validPlant,
						plan: { ...validPlant.plan, mode: "overlay" },
					}),
					"utf8",
				),
			).toString("base64url"),
			gzipSync(
				Buffer.from(
					JSON.stringify({
						...validPlant,
						plan: { ...validPlant.plan, variations: [] },
					}),
					"utf8",
				),
			).toString("base64url"),
			gzipSync(
				Buffer.from(
					JSON.stringify({
						...validPlant,
						plan: {
							...validPlant.plan,
							slug: "different-slug",
						},
					}),
					"utf8",
				),
			).toString("base64url"),
			gzipSync(
				Buffer.from(
					JSON.stringify({
						...validPlant,
						plan: {
							...validPlant.plan,
							variations: [
								{
									...validPlant.plan.variations[0],
									key: "../escape",
								},
							],
						},
					}),
					"utf8",
				),
			).toString("base64url"),
		];

		for (const marker of malformedMarkers) {
			expect(
				await readProtoPayload(
					`https://example.test/account#tab=activity&_proto=${marker}`,
				),
			).toBeUndefined();
		}
	});

	test("rejects a valid bounded payload whose encoding exceeds the transport ceiling", async () => {
		const payload = buildPlantPayload();
		payload.plan.question = deterministicNoise(100_000);
		const json = JSON.stringify(payload);
		const encoded = gzipSync(Buffer.from(json, "utf8")).toString("base64url");
		const markupCharacters = payload.plan.variations.reduce(
			(total, variation) =>
				total + variation.html.length + variation.css.length,
			0,
		);

		expect(Buffer.byteLength(json)).toBeLessThan(PROTO_EXPANDED_MAX_BYTES);
		expect(markupCharacters).toBeLessThanOrEqual(PROTO_MAX_MARKUP_CHARS);
		expect(payload.plan.variations.length).toBeLessThanOrEqual(
			PROTO_MAX_VARIATIONS,
		);
		expect(encoded.length).toBeGreaterThan(PROTO_ENCODED_MAX_LENGTH);
		expect(await readProtoPayload(directMarker(encoded))).toBeUndefined();
	});

	test("rejects gzip expansion beyond the pre-allocation byte cap", async () => {
		const validJson = JSON.stringify(buildPlantPayload());
		const expanded = `${validJson}${" ".repeat(
			PROTO_EXPANDED_MAX_BYTES - Buffer.byteLength(validJson) + 1,
		)}`;
		const encoded = gzipSync(Buffer.from(expanded, "utf8")).toString(
			"base64url",
		);

		expect(encoded.length).toBeLessThan(PROTO_ENCODED_MAX_LENGTH);
		expect(await readProtoPayload(directMarker(encoded))).toBeUndefined();
	});

	test("rejects plant payloads with more than five variations", async () => {
		const payload = buildPlantPayload();
		const variations = Array.from(
			{ length: PROTO_MAX_VARIATIONS + 1 },
			(_, index) => ({
				...payload.plan.variations[0],
				key: `variation-${index}`,
			}),
		);

		expect(
			await readProtoPayload(
				directMarker(
					gzipMarker({ ...payload, plan: { ...payload.plan, variations } }),
				),
			),
		).toBeUndefined();
	});

	test("rejects combined variation markup over the render cap", async () => {
		const payload = buildPlantPayload();
		const oversized = {
			...payload,
			plan: {
				...payload.plan,
				variations: [
					{
						...payload.plan.variations[0],
						html: "x".repeat(PROTO_MAX_MARKUP_CHARS + 1),
						css: "",
					},
				],
			},
		};
		const encoded = gzipMarker(oversized);

		expect(encoded.length).toBeLessThan(PROTO_ENCODED_MAX_LENGTH);
		expect(await readProtoPayload(directMarker(encoded))).toBeUndefined();
	});
});
