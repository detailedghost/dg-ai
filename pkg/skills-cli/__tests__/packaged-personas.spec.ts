import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	installPackagedPersonas,
	packagedPersonas,
} from "../src/proxy/packaged-personas";
import { resolvePersona } from "../src/proxy/persona";

const AGENTS = join(import.meta.dir, "../../../plugins/dg/agents");

const PERSONAS = [
	"arch",
	"checkpoint",
	"copilot-antagonist",
	"csharp",
	"dba",
	"design",
	"devops",
	"foreman",
	"js",
	"lore",
	"python",
	"qa-code",
	"qa-devops",
	"qa-perf",
	"qa-writer",
	"reviewer",
	"security",
	"shell",
	"thrash",
	"wave",
];

describe("packaged personas", () => {
	test("embed every file in plugins/dg/agents", () => {
		const shipped = readdirSync(AGENTS)
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.slice(0, -3))
			.sort();
		expect(shipped).toEqual(PERSONAS);
		expect(Object.keys(packagedPersonas).sort()).toEqual(PERSONAS);
		for (const name of PERSONAS) {
			expect(packagedPersonas[name]).toBe(readFileSync(join(AGENTS, `${name}.md`), "utf8"));
		}
	});

	test("resolvePersona accepts the dg: plugin prefix", async () => {
		const home = mkdtempSync(join(tmpdir(), "persona-prefix-"));
		const previous = process.env.HOME;
		process.env.HOME = home;
		try {
			expect(await resolvePersona({ subagent: "dg:foreman" })).toBe(
				readFileSync(join(AGENTS, "foreman.md"), "utf8"),
			);
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("resolvePersona ignores inherited object keys", async () => {
		const home = mkdtempSync(join(tmpdir(), "persona-keys-"));
		const previous = process.env.HOME;
		process.env.HOME = home;
		try {
			await expect(resolvePersona({ subagent: "constructor" })).rejects.toThrow(
				/Agent persona not found: constructor/,
			);
			await expect(resolvePersona({ subagent: "toString" })).rejects.toThrow(
				/Agent persona not found: toString/,
			);
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("installPackagedPersonas", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "packaged-personas-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	test("writes all 20 personas beside the skills directory", () => {
		const written = installPackagedPersonas(join(directory, "skills"));
		expect(written).toEqual(PERSONAS.map((name) => `${name}.md`));
		const installed = join(directory, "agents");
		expect(readdirSync(installed).sort()).toEqual(PERSONAS.map((name) => `${name}.md`));
		for (const name of PERSONAS) {
			expect(readFileSync(join(installed, `${name}.md`), "utf8")).toBe(
				readFileSync(join(AGENTS, `${name}.md`), "utf8"),
			);
		}
	});
});
