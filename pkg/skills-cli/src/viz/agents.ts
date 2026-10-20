import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { vizConfig } from "./config";

export interface SubagentInfo {
	name: string;
	description: string;
}

function parseAgentFrontmatter(text: string): {
	name?: string;
	description?: string;
} {
	const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) return {};
	const fm = fmMatch[1];
	const nameMatch = fm.match(/^name:\s*"?(.*?)"?\s*$/m);
	const blockMatch = fm.match(
		/^description:\s*[>|][+-]?\s*\n((?:[ \t]+.*\n?)*)/m,
	);
	if (blockMatch) {
		const description = blockMatch[1]
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.join(" ");
		return { name: nameMatch?.[1], description };
	}
	const descMatch = fm.match(/^description:\s*"?(.*?)"?\s*$/m);
	return { name: nameMatch?.[1], description: descMatch?.[1] };
}

function scanAgentDir(dir: string): SubagentInfo[] {
	if (!existsSync(dir)) return [];
	const agents: SubagentInfo[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		try {
			const text = readFileSync(`${dir}/${file}`, "utf-8");
			const { name, description } = parseAgentFrontmatter(text);
			agents.push({
				name: name || file.replace(/\.md$/, ""),
				description: description ?? "",
			});
		} catch {}
	}
	return agents;
}

/** Global and repo-local subagents; a local entry wins a name collision. */
function scanSubagents(repo: string): SubagentInfo[] {
	const byName = new Map<string, SubagentInfo>();
	for (const a of [
		...scanAgentDir(`${homedir()}/.claude/agents`),
		...scanAgentDir(`${repo}/.claude/agents`),
	])
		byName.set(a.name, a);
	return Array.from(byName.values());
}

export function scanAndCacheSubagents(repo: string): SubagentInfo[] {
	const agents = scanSubagents(repo);
	try {
		writeFileSync(
			`${vizConfig().vizDir}/agents-cache.json`,
			JSON.stringify(agents, null, "\t"),
		);
	} catch {
		return agents;
	}
	return agents;
}
