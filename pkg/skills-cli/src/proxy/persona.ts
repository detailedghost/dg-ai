import { homedir } from "node:os";
import { join } from "node:path";
import { bareAgent } from "@dg/common";
import { packagedPersonas } from "./packaged-personas";
import { resolveSlicePrimary } from "./spec-persona";

async function readAgentPersona(requested: string): Promise<string> {
	const name = bareAgent(requested);
	if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid agent persona name: ${name}`);
	const home = process.env.HOME ?? homedir();
	const directory = process.env.DG_PERSONAS_DIR ?? process.env.DG_AGENTS_DIR ?? join(home, ".claude", "agents");
	const path = join(directory, `${name}.md`);
	const file = Bun.file(path);
	if (await file.exists()) return file.text();
	if (Object.hasOwn(packagedPersonas, name)) return packagedPersonas[name];
	throw new Error(`Agent persona not found: ${name} (looked in ${path})`);
}

/** Load an explicit persona or a plan slice's primary agent; explicit subagent wins and missing files reject. */
export async function resolvePersona(opts: { subagent?: string; spec?: string; slice?: string }): Promise<string | null> {
	if (opts.subagent) return readAgentPersona(opts.subagent);
	if (opts.spec && opts.slice) {
		const primary = resolveSlicePrimary(opts.spec, opts.slice);
		return primary ? readAgentPersona(primary) : null;
	}
	return null;
}

/** Prepend the role briefing when present; null preserves the original prompt unchanged. */
export function withPersona(persona: string | null, prompt: string): string {
	if (persona === null) return prompt;
	return `You are being briefed to act as the following specialized role:\n\n${persona}\n\n---\nTask:\n${prompt}`;
}
