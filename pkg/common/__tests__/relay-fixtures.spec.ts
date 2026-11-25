import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, RELAY_FEATURES, validateChatFrame } from "../src/index";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "relay");
const DOC = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "relay-protocol.md"), "utf8");

type Fixture = { name: string; validator: string; frame: unknown; error?: string };

function load(dir: "valid" | "invalid"): Fixture[] {
	return readdirSync(join(FIXTURES, dir))
		.filter((file) => file.endsWith(".json"))
		.sort()
		.map((file) => ({
			name: file.slice(0, -".json".length),
			...JSON.parse(readFileSync(join(FIXTURES, dir, file), "utf8")),
		}));
}

function featureNamed(name: string) {
	const feature = RELAY_FEATURES.find((candidate) => candidate.name === name);
	if (!feature) throw new Error(`no relay feature named ${name}`);
	return feature;
}

function validate({ validator, frame }: Fixture): unknown {
	if (validator === "chat-frame") return validateChatFrame(frame);
	const [kind, feature] = validator.split(":");
	const table = featureNamed(feature);
	if (kind === "cli-request") return table.validateCliRequest(frame);
	if (kind === "cli-cancel" && "validateCliCancel" in table) return table.validateCliCancel(frame);
	throw new Error(`unknown fixture validator ${validator}`);
}

function failureOf(fixture: Fixture): string | undefined {
	try {
		validate(fixture);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return undefined;
}

const valid = load("valid");
const invalid = load("invalid");
const typeOf = ({ frame }: Fixture) => (frame as { type: string }).type;

describe("relay contract fixtures", () => {
	it.each(valid)("accepts valid fixture $name", (fixture) => {
		expect(failureOf(fixture)).toBeUndefined();
	});

	it.each(invalid)("rejects invalid fixture $name with its documented error", (fixture) => {
		expect(failureOf(fixture)).toBe(fixture.error as string);
	});

	it("names a known validator in every fixture", () => {
		const names = new Set(["chat-frame", ...RELAY_FEATURES.flatMap(({ name }) => [`cli-request:${name}`, `cli-cancel:${name}`])]);
		for (const { name, validator } of [...valid, ...invalid]) {
			expect({ name, known: names.has(validator) }).toEqual({ name, known: true });
		}
	});
});

describe("relay contract coverage", () => {
	const requestFrames = RELAY_FEATURES.flatMap(({ frames }) => {
		const { cliResult: _, ...validated } = frames;
		return Object.values(validated).filter((type): type is string => type !== undefined);
	});
	const resultFrames = RELAY_FEATURES.map(({ frames }) => frames.cliResult);

	it.each(requestFrames)("has a valid and an invalid fixture for %s", (type) => {
		expect(valid.some((fixture) => typeOf(fixture) === type)).toBe(true);
		expect(invalid.some((fixture) => typeOf(fixture) === type)).toBe(true);
	});

	it.each([...requestFrames, ...resultFrames, "error", "connect"])("documents the %s frame", (type) => {
		expect(DOC).toContain(`\`${type}\``);
	});

	it("documents the current protocol version", () => {
		expect(DOC).toContain(`Current protocol version: ${CHAT_PROTOCOL_VERSION}`);
	});
});
