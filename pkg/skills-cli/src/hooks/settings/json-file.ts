import {
	accessSync,
	constants,
	mkdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic, writeTarget } from "@dg/common/node";

export type JsonObject = Record<string, unknown>;

export interface UpdateSeams {
	afterRead?: () => void;
}

const ATTEMPTS = 3;
const NEW_FILE_MODE = 0o600;

function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function parseJsonObject(
	file: string,
	text: string | undefined,
): JsonObject {
	if (text === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.replace(/^﻿/, ""));
	} catch (error) {
		throw new Error(
			`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it and run the command again`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`${file} is not a JSON object`);
	return parsed as JsonObject;
}

export function readJsonObject(file: string): JsonObject {
	return parseJsonObject(file, readText(file));
}

export async function updateJsonFile(
	file: string,
	mutate: (doc: JsonObject) => JsonObject,
	seams: UpdateSeams = {},
): Promise<void> {
	const target = writeTarget(file);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const before = readText(target);
		const current = parseJsonObject(file, before);
		const next = mutate(current);
		seams.afterRead?.();
		if (readText(target) !== before) continue;
		if (JSON.stringify(next) === JSON.stringify(current)) return;
		mkdirSync(dirname(target), { recursive: true });
		if (before !== undefined) accessSync(target, constants.W_OK);
		const mode =
			before === undefined ? NEW_FILE_MODE : statSync(target).mode & 0o777;
		writeFileAtomic(target, `${JSON.stringify(next, null, 2)}\n`, mode);
		return;
	}
	throw new Error(`${file} kept changing; try again`);
}
