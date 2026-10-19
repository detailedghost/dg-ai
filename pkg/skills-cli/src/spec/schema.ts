import { join } from "node:path";
import { isRecord } from "@dg/common";
import { resolveSkillAsset } from "../utils/skill-assets";
import { parseYaml } from "./frontmatter";
import { die, isFile, needFile, readText } from "./shared";

export interface FieldSpec {
	type?: string | string[];
	mutability?: string;
	mode_conditional?: string;
	enum?: unknown[];
}

export type SchemaFields = Record<string, FieldSpec>;

export function schemaAsset(relativePath: string): string {
	const override = process.env.SPEC_SCHEMA_DIR;
	if (override) {
		const path = join(override, relativePath);
		needFile(path);
		return path;
	}
	try {
		return resolveSkillAsset("spec", `spec-schema/${relativePath}`);
	} catch (error) {
		return die(error instanceof Error ? error.message : String(error));
	}
}

export async function loadSchema(): Promise<SchemaFields> {
	const path = schemaAsset("frontmatter-schema.yaml");
	if (!isFile(path)) die(`file not found: ${path}`);
	const parsed = parseYaml(await readText(path));
	if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.fields))
		return die(`schema is not valid YAML: ${path}`);
	return parsed.value.fields as SchemaFields;
}
