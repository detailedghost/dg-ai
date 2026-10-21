import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bareAgent, PLUGIN_AGENT_PREFIX } from "@dg/common";
import { personasDest } from "@dg/common/node";
import arch from "../../../../plugins/dg/agents/arch.md" with { type: "text" };
import checkpoint from "../../../../plugins/dg/agents/checkpoint.md" with { type: "text" };
import copilotAntagonist from "../../../../plugins/dg/agents/copilot-antagonist.md" with { type: "text" };
import csharp from "../../../../plugins/dg/agents/csharp.md" with { type: "text" };
import dba from "../../../../plugins/dg/agents/dba.md" with { type: "text" };
import design from "../../../../plugins/dg/agents/design.md" with { type: "text" };
import devops from "../../../../plugins/dg/agents/devops.md" with { type: "text" };
import foreman from "../../../../plugins/dg/agents/foreman.md" with { type: "text" };
import js from "../../../../plugins/dg/agents/js.md" with { type: "text" };
import lore from "../../../../plugins/dg/agents/lore.md" with { type: "text" };
import python from "../../../../plugins/dg/agents/python.md" with { type: "text" };
import qaCode from "../../../../plugins/dg/agents/qa-code.md" with { type: "text" };
import qaDevops from "../../../../plugins/dg/agents/qa-devops.md" with { type: "text" };
import qaPerf from "../../../../plugins/dg/agents/qa-perf.md" with { type: "text" };
import qaWriter from "../../../../plugins/dg/agents/qa-writer.md" with { type: "text" };
import reviewer from "../../../../plugins/dg/agents/reviewer.md" with { type: "text" };
import security from "../../../../plugins/dg/agents/security.md" with { type: "text" };
import shell from "../../../../plugins/dg/agents/shell.md" with { type: "text" };
import thrash from "../../../../plugins/dg/agents/thrash.md" with { type: "text" };
import wave from "../../../../plugins/dg/agents/wave.md" with { type: "text" };

/** Personas shipped in plugins/dg/agents, embedded so a relocated binary can brief backends. */
export const packagedPersonas: Record<string, string> = {
	arch,
	checkpoint,
	"copilot-antagonist": copilotAntagonist,
	csharp,
	dba,
	design,
	devops,
	foreman,
	js,
	lore,
	python,
	"qa-code": qaCode,
	"qa-devops": qaDevops,
	"qa-perf": qaPerf,
	"qa-writer": qaWriter,
	reviewer,
	security,
	shell,
	thrash,
	wave,
};

/** The name Claude Code gives a plugin agent; other names pass through unchanged. */
export function qualifiedAgent(name: string): string {
	const bare = bareAgent(name);
	return Object.hasOwn(packagedPersonas, bare) ? `${PLUGIN_AGENT_PREFIX}${bare}` : name;
}

/** Write every embedded persona beside the skills directory; a link at a destination is replaced. */
export function installPackagedPersonas(skillsDest: string): string[] {
	const destDir = personasDest(skillsDest);
	mkdirSync(destDir, { recursive: true });
	const names = Object.keys(packagedPersonas).sort().map((name) => `${name}.md`);
	for (const file of names) {
		const to = join(destDir, file);
		rmSync(to, { force: true });
		writeFileSync(to, packagedPersonas[file.slice(0, -3)]);
		chmodSync(to, 0o644);
	}
	return names;
}
