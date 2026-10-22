/**
 * Ported from the legacy `~/scripts/ai/sync/__tests__/agent-transform.test.ts`.
 * Calls `transformAgentText` directly instead of spawning a CLI — the port
 * dropped the CLI entirely (agent-transform is now an in-process function
 * called by the copilot/opencode targets), so the four "integration: sync
 * wiring" tests that asserted the retired shell scripts' own source text are
 * dropped; there is no longer a shell script to assert against.
 */

import { describe, expect, test } from "bun:test";
import { transformAgentText } from "../../src/sync/agent-transform";

const CANONICAL = {
	sonnet: { opencode: "anthropic/claude-sonnet-4-6", copilot: "claude-sonnet-4-6" },
	haiku: { opencode: "anthropic/claude-haiku-4-5", copilot: "claude-haiku-4-5" },
	opus: { opencode: "anthropic/claude-opus-4-8", copilot: "claude-opus-4-8" },
} as const;

function splitFrontmatter(content: string): { fields: Record<string, string>; body: string } {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!match) return { fields: {}, body: content };
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (m) fields[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
	}
	return { fields, body: match[2] };
}

function quoteUnquotedHex(yaml: string): string {
	return yaml.replace(/^(\s*\w[\w-]*\s*:\s*)(#[0-9a-fA-F]{3,6})\s*$/gm, '$1"$2"');
}

function parseFrontmatterYaml(content: string): Record<string, unknown> {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
	if (!match) throw new Error("no frontmatter found");
	return Bun.YAML.parse(quoteUnquotedHex(match[1])) as Record<string, unknown>;
}

const FIXTURE_JS = `---
name: js
description: Help with JavaScript and TypeScript development including React, Next.js, Node.js, Jest testing, Bun, CSS/styling, state management, performance, and accessibility.
model: sonnet
color: gray
memory: user
---

You are **The Artisan** — a JavaScript and TypeScript craftsperson.
## TypeScript
- TypeScript by default; strict mode, no \`any\` unless absolutely cornered
`;

const FIXTURE_QA_WRITER = `---
name: qa-writer
description: Dedicated test writer — reads spec Testing Criteria + implementation files and writes tests. Updates Testing Criteria checkboxes only.
model: sonnet
color: yellow
memory: user
---

You are **The Test Smith** — a dedicated test author who forges tests like a blacksmith forges tools.
`;

const FIXTURE_MULTILINE_SPECIAL = `---
name: multiline-special
description: Agent with YAML special chars in body.
model: haiku
color: cyan
---

Here are special chars: \`code\`, "quoted", 'apostrophe', colon: value, [bracket], {brace}.
Multi-line with indent:
  - list item: with colon
  - another: "quoted value"
`;

const FIXTURE_COLON_HASH = `---
name: colon-hash
description: "Has: a colon and a # hash and a: b"
model: sonnet
---

Body text.
`;

const OPENCODE_REF_JS = `---
description: Help with JavaScript and TypeScript development including React, Next.js, Node.js, Jest testing, Bun, CSS/styling, state management, performance, and accessibility.
mode: subagent
color: secondary
model: anthropic/claude-sonnet-4-6
---

You are **The Artisan** — a JavaScript and TypeScript craftsperson.
## TypeScript
- TypeScript by default; strict mode, no \`any\` unless absolutely cornered
`;

const OPENCODE_REF_QA_WRITER = `---
description: Dedicated test writer — reads spec Testing Criteria + implementation files and writes tests. Updates Testing Criteria checkboxes only.
mode: subagent
color: warning
model: anthropic/claude-sonnet-4-6
---

You are **The Test Smith** — a dedicated test author who forges tests like a blacksmith forges tools.
`;

const COPILOT_REF_JS = `---
name: "js"
description: "Help with JavaScript and TypeScript development including React, Next.js, Node.js, Jest testing, Bun, CSS/styling, state management, performance, and accessibility."
model: "claude-sonnet-4-6"
---

You are **The Artisan** — a JavaScript and TypeScript craftsperson.
## TypeScript
- TypeScript by default; strict mode, no \`any\` unless absolutely cornered
`;

const COPILOT_REF_QA_WRITER = `---
name: "qa-writer"
description: "Dedicated test writer — reads spec Testing Criteria + implementation files and writes tests. Updates Testing Criteria checkboxes only."
model: "claude-sonnet-4-6"
---

You are **The Test Smith** — a dedicated test author who forges tests like a blacksmith forges tools.
`;

describe("agent-transform YAML error handling", () => {
	test("malformed YAML frontmatter fails with code 2", () => {
		const r = transformAgentText("---\nbad: :\n  broken: yaml\n  wrong\n---\nbody\n", "opencode", "bad");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe(2);
	});

	test("file with no frontmatter delimiter fails with code 2 (opencode)", () => {
		const r = transformAgentText("Just a body, no frontmatter.\n", "opencode", "nofm");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe(2);
			expect(r.message).toMatch(/frontmatter/i);
		}
	});
});

describe("agent-transform path-traversal guard (CWE-22)", () => {
	test("name field '../escape' fails with code 3", () => {
		const r = transformAgentText("---\nname: ../escape\ndescription: test\n---\nbody\n", "opencode", "traversal");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe(3);
	});

	test("absolute path name fails with code 3", () => {
		const r = transformAgentText("---\nname: /absolute/path\ndescription: test\n---\nbody\n", "opencode", "absolute");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe(3);
	});

	test("double-dot in middle of name fails with code 3", () => {
		const r = transformAgentText("---\nname: a/../../escape\ndescription: test\n---\nbody\n", "opencode", "dotdot");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe(3);
	});

	test("safe name succeeds (guard does not over-fire)", () => {
		const r = transformAgentText(FIXTURE_JS, "opencode", "js");
		expect(r.ok).toBe(true);
	});

	test("copilot target: '../escape' fails with code 3", () => {
		const r = transformAgentText("---\nname: ../escape\ndescription: test\n---\nbody\n", "copilot", "traversal");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe(3);
	});
});

describe("agent-transform OpenCode output target", () => {
	test("produces filename js.md", () => {
		const r = transformAgentText(FIXTURE_JS, "opencode", "js");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.filename).toBe("js.md");
	});

	test("frontmatter deep-equals reference output (js fixture)", () => {
		const r = transformAgentText(FIXTURE_JS, "opencode", "js");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const tsOut = splitFrontmatter(r.content);
		const ref = splitFrontmatter(OPENCODE_REF_JS);
		expect(tsOut.fields.description).toBe(ref.fields.description);
		expect(tsOut.fields.mode).toBe(ref.fields.mode);
		expect(tsOut.fields.color).toBe(ref.fields.color);
		expect(tsOut.fields.name).toBeUndefined();
		expect(tsOut.fields.memory).toBeUndefined();
		expect(tsOut.fields.variant).toBeUndefined();
	});

	test("body byte-identical to reference (js fixture)", () => {
		const r = transformAgentText(FIXTURE_JS, "opencode", "js");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(splitFrontmatter(r.content).body).toBe(splitFrontmatter(OPENCODE_REF_JS).body);
	});

	test("frontmatter deep-equals reference output (qa-writer fixture)", () => {
		const r = transformAgentText(FIXTURE_QA_WRITER, "opencode", "qa-writer");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const tsOut = splitFrontmatter(r.content);
		const ref = splitFrontmatter(OPENCODE_REF_QA_WRITER);
		expect(tsOut.fields.description).toBe(ref.fields.description);
		expect(tsOut.fields.mode).toBe(ref.fields.mode);
		expect(tsOut.fields.color).toBe(ref.fields.color);
		expect(tsOut.fields.name).toBeUndefined();
	});

	test("body byte-identical to reference (qa-writer fixture)", () => {
		const r = transformAgentText(FIXTURE_QA_WRITER, "opencode", "qa-writer");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(splitFrontmatter(r.content).body).toBe(splitFrontmatter(OPENCODE_REF_QA_WRITER).body);
	});

	test("multi-line body with YAML special chars round-trips correctly", () => {
		const r = transformAgentText(FIXTURE_MULTILINE_SPECIAL, "opencode", "multiline-special");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const { fields, body } = splitFrontmatter(r.content);
		expect(fields.description).toBe("Agent with YAML special chars in body.");
		expect(fields.mode).toBe("subagent");
		const srcBody = splitFrontmatter(FIXTURE_MULTILINE_SPECIAL).body;
		expect(body).toBe(srcBody);
	});
});

describe("agent-transform Copilot output target", () => {
	test("produces filename js.agent.md", () => {
		const r = transformAgentText(FIXTURE_JS, "copilot", "js");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.filename).toBe("js.agent.md");
	});

	test("copilot output includes name field in frontmatter", () => {
		const r = transformAgentText(FIXTURE_JS, "copilot", "js");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(splitFrontmatter(r.content).fields.name).toBe("js");
	});

	test("copilot output body matches source body", () => {
		const r = transformAgentText(FIXTURE_QA_WRITER, "copilot", "qa-writer");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(splitFrontmatter(r.content).body).toBe(splitFrontmatter(FIXTURE_QA_WRITER).body);
	});

	test("copilot output omits color field", () => {
		const r = transformAgentText(FIXTURE_JS, "copilot", "js");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.content).not.toContain("color:");
	});
});

describe("agent-transform MODEL_MAP — unified canonical IDs", () => {
	function extractModel(content: string): string {
		return splitFrontmatter(content).fields.model ?? "";
	}

	test("opencode: 'sonnet' maps to anthropic/claude-sonnet-4-6", () => {
		const r = transformAgentText(FIXTURE_JS, "opencode", "js");
		expect(r.ok).toBe(true);
		if (r.ok) expect(extractModel(r.content)).toBe(CANONICAL.sonnet.opencode);
	});

	test("opencode: 'haiku' maps to anthropic/claude-haiku-4-5", () => {
		const r = transformAgentText(FIXTURE_MULTILINE_SPECIAL, "opencode", "multiline-special");
		expect(r.ok).toBe(true);
		if (r.ok) expect(extractModel(r.content)).toBe(CANONICAL.haiku.opencode);
	});

	test("opencode: 'opus' maps to anthropic/claude-opus-4-8", () => {
		const r = transformAgentText("---\nname: arch\ndescription: Architecture agent.\nmodel: opus\n---\nBody.\n", "opencode", "arch");
		expect(r.ok).toBe(true);
		if (r.ok) expect(extractModel(r.content)).toBe(CANONICAL.opus.opencode);
	});

	test("copilot: 'sonnet' maps to claude-sonnet-4-6 (no anthropic/ prefix)", () => {
		const r = transformAgentText(FIXTURE_JS, "copilot", "js");
		expect(r.ok).toBe(true);
		if (r.ok) {
			const model = extractModel(r.content);
			expect(model).toBe(CANONICAL.sonnet.copilot);
			expect(model).not.toMatch(/^anthropic\//);
		}
	});

	test("'inherit' alias produces no model field in opencode output", () => {
		const r = transformAgentText(
			"---\nname: inherit-agent\ndescription: Inherit test.\nmodel: inherit\n---\nBody.\n",
			"opencode",
			"inherit-agent",
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(splitFrontmatter(r.content).fields.model).toBeUndefined();
	});

	test("full model string with slash passes through unchanged (opencode)", () => {
		const r = transformAgentText(
			"---\nname: passthru\ndescription: Passthrough test.\nmodel: anthropic/custom-model\n---\nBody.\n",
			"opencode",
			"passthru",
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(extractModel(r.content)).toBe("anthropic/custom-model");
	});

	test("explicitly-qualified model with anthropic/ prefix strips prefix for copilot", () => {
		const r = transformAgentText(
			"---\nname: fqmodel\ndescription: Test.\nmodel: anthropic/claude-sonnet-4-6\n---\nBody.\n",
			"copilot",
			"fqmodel",
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(extractModel(r.content)).toBe("claude-sonnet-4-6");
	});
});

describe("agent-transform translate_color", () => {
	function colorOf(colorName: string, target: "opencode" | "copilot" = "opencode"): string {
		const r = transformAgentText(
			`---\nname: color-agent\ndescription: Color test.\ncolor: ${colorName}\n---\nBody.\n`,
			target,
			"color-agent",
		);
		if (!r.ok) throw new Error(r.message);
		return splitFrontmatter(r.content).fields.color ?? "";
	}

	test("'gray' maps to 'secondary'", () => expect(colorOf("gray")).toBe("secondary"));
	test("'grey' maps to 'secondary'", () => expect(colorOf("grey")).toBe("secondary"));
	test("'red' maps to 'error'", () => expect(colorOf("red")).toBe("error"));
	test("'orange' maps to 'warning'", () => expect(colorOf("orange")).toBe("warning"));
	test("'yellow' maps to 'warning'", () => expect(colorOf("yellow")).toBe("warning"));
	test("'cyan' maps to 'info'", () => expect(colorOf("cyan")).toBe("info"));
	test("'purple' maps to 'accent'", () => expect(colorOf("purple")).toBe("accent"));
	test("'green' maps to 'success'", () => expect(colorOf("green")).toBe("success"));
	test("hex color '#ff0000' passes through unchanged", () => expect(colorOf("#ff0000")).toBe("#ff0000"));
	test("theme token 'error' passes through unchanged", () => expect(colorOf("error")).toBe("error"));
	test("missing color field omits color in output", () => {
		const r = transformAgentText("---\nname: nocolor\ndescription: Test.\n---\nBody.\n", "opencode", "nocolor");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.content).not.toContain("color:");
	});
});

describe("agent-transform translate_tools", () => {
	function toolsOf(toolsYaml: string): Record<string, string> {
		const content = `---\nname: tools-agent\ndescription: Tools test.\ntools:\n${toolsYaml}\n---\nBody.\n`;
		const r = transformAgentText(content, "opencode", "tools-agent");
		if (!r.ok) throw new Error(r.message);
		const permMatch = r.content.match(/permission:\s*\n((?:\s+\w+: \w+\n?)+)/);
		if (!permMatch) return {};
		const result: Record<string, string> = {};
		for (const line of permMatch[1].split("\n")) {
			const m = line.match(/\s+(\w+):\s+(\w+)/);
			if (m) result[m[1]] = m[2];
		}
		return result;
	}

	test("'bash' tool maps to permission.bash = allow", () => expect(toolsOf("  - bash").bash).toBe("allow"));
	test("'read' tool maps to permission.read = allow", () => expect(toolsOf("  - read").read).toBe("allow"));
	test("'write' and 'edit' both map to permission.edit = allow (no duplicate, first wins)", () => {
		expect(toolsOf("  - write\n  - edit").edit).toBe("allow");
	});
});

describe("agent-transform Copilot structural comparison", () => {
	test("frontmatter + body deep-equal reference output (js fixture)", () => {
		const r = transformAgentText(FIXTURE_JS, "copilot", "js");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const tsOut = splitFrontmatter(r.content);
		const ref = splitFrontmatter(COPILOT_REF_JS);
		expect(tsOut.fields.name).toBe(ref.fields.name);
		expect(tsOut.fields.description).toBe(ref.fields.description);
		expect(tsOut.fields.model).toBe(ref.fields.model);
		expect(tsOut.fields.color).toBeUndefined();
		expect(tsOut.body).toBe(ref.body);
	});

	test("frontmatter + body deep-equal reference output (qa-writer fixture)", () => {
		const r = transformAgentText(FIXTURE_QA_WRITER, "copilot", "qa-writer");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const tsOut = splitFrontmatter(r.content);
		const ref = splitFrontmatter(COPILOT_REF_QA_WRITER);
		expect(tsOut.fields.name).toBe(ref.fields.name);
		expect(tsOut.fields.description).toBe(ref.fields.description);
		expect(tsOut.fields.model).toBe(ref.fields.model);
		expect(tsOut.body).toBe(ref.body);
	});
});

describe("agent-transform Copilot edge cases", () => {
	test("file with no frontmatter delimiter succeeds (copilot fallback: filename as name)", () => {
		const r = transformAgentText("Just plain body text, no YAML header.\n", "copilot", "barebones");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.filename).toBe("barebones.agent.md");
			expect(r.content).toContain('"barebones"');
		}
	});

	test("missing description field falls back to generated description", () => {
		const r = transformAgentText("---\nname: nodesc\n---\nBody.\n", "copilot", "nodesc");
		expect(r.ok).toBe(true);
		if (r.ok) expect(splitFrontmatter(r.content).fields.description.length).toBeGreaterThan(0);
	});

	test("body with leading blank lines: leading newlines stripped in copilot output", () => {
		const r = transformAgentText("---\nname: leadnl\ndescription: Test.\n---\n\n\nActual body starts here.\n", "copilot", "leadnl");
		expect(r.ok).toBe(true);
		if (r.ok) {
			const { body } = splitFrontmatter(r.content);
			expect(body.startsWith("\n")).toBe(false);
			expect(body).toContain("Actual body starts here.");
		}
	});

	test("unknown model alias produces no model field (copilot)", () => {
		const r = transformAgentText("---\nname: unknown-model\ndescription: Test.\nmodel: gpt-4\n---\nBody.\n", "copilot", "unknown-model");
		expect(r.ok).toBe(true);
		if (r.ok) expect(splitFrontmatter(r.content).fields.model).toBeUndefined();
	});

	test("emit format uses JSON.stringify quoting for all fields", () => {
		const r = transformAgentText(FIXTURE_JS, "copilot", "js");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.content).toContain('name: "js"');
			expect(r.content).toContain('model: "claude-sonnet-4-6"');
		}
	});
});

describe("agent-transform OpenCode edge cases", () => {
	test("unknown model alias falls through unchanged (opencode: no anthropic/ prefix added)", () => {
		const r = transformAgentText("---\nname: unknown-oc\ndescription: Test.\nmodel: gpt-unknown\n---\nBody.\n", "opencode", "unknown-oc");
		expect(r.ok).toBe(true);
		if (r.ok) expect(splitFrontmatter(r.content).fields.model).toBeUndefined();
	});

	test("body with leading blank lines is trimmed in opencode output", () => {
		const r = transformAgentText("---\nname: leadnl-oc\ndescription: Test.\n---\n\n\nActual body.\n", "opencode", "leadnl-oc");
		expect(r.ok).toBe(true);
		if (r.ok) {
			const { body } = splitFrontmatter(r.content);
			expect(body.startsWith("\n")).toBe(false);
			expect(body).toContain("Actual body.");
		}
	});
});

describe("agent-transform YAML round-trip", () => {
	test("opencode: description with colon-space and leading # parses and round-trips", () => {
		const r = transformAgentText(FIXTURE_COLON_HASH, "opencode", "colon-hash");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const parsed = parseFrontmatterYaml(r.content);
		expect(parsed.description).toBe("Has: a colon and a # hash and a: b");
		expect(parsed.mode).toBe("subagent");
	});

	test("copilot: description with colon-space and leading # parses and round-trips", () => {
		const r = transformAgentText(FIXTURE_COLON_HASH, "copilot", "colon-hash");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const parsed = parseFrontmatterYaml(r.content);
		expect(parsed.description).toBe("Has: a colon and a # hash and a: b");
	});

	test("opencode: js fixture frontmatter deep-equals expected object via Bun.YAML.parse", () => {
		const r = transformAgentText(FIXTURE_JS, "opencode", "js");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const parsed = parseFrontmatterYaml(r.content);
		expect(parsed.mode).toBe("subagent");
		expect(parsed.color).toBe("secondary");
		expect(parsed.model).toBe(CANONICAL.sonnet.opencode);
	});
});
