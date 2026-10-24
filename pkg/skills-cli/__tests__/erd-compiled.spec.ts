import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsCli } from "../build";

setDefaultTimeout(60_000);

const root = mkdtempSync(join(tmpdir(), "dg-erd-compiled-"));
const cwd = join(root, "external-cwd");
const emptyPath = join(root, "empty-bin");
const binary = join(root, "moved-install", "dg-skills");
const entrypoint = join(root, "erd-entry.ts");

beforeAll(async () => {
	for (const directory of [cwd, emptyPath, join(binary, ".."), join(cwd, "src")]) {
		mkdirSync(directory, { recursive: true });
	}
	writeFileSync(join(cwd, "src", "index.ts"), 'import { value } from "./value";\nexport { value };\n');
	writeFileSync(join(cwd, "src", "value.ts"), "export const value = 1;\n");
	writeFileSync(
		entrypoint,
		`import { Command } from ${JSON.stringify(Bun.resolveSync("commander", import.meta.dir))};
import { registerErd } from ${JSON.stringify(join(import.meta.dir, "../src/commands/erd.ts"))};
import { registerRawCommand } from ${JSON.stringify(join(import.meta.dir, "../src/utils/legacy-command.ts"))};
const program = new Command().name("dg-skills").enablePositionalOptions();
registerRawCommand(program, {
  name: "db",
  run(argv) {
    if (argv[0] === "connections") {
      process.stdout.write("CONNECTIONS: 1\\nname\\tengine\\ttarget\\nmain\\tpostgresql\\tlocalhost\\n");
      return 0;
    }
    if (argv[0] === "schema") {
      process.stdout.write(
        JSON.stringify({
          tables: [
            {
              name: "widgets",
              schema: "public",
              columns: [{ name: "id", dataType: "uuid", nullable: false, isPrimaryKey: true, isForeignKey: false }],
              foreignKeys: [],
            },
          ],
        }) + "\\n",
      );
      return 0;
    }
    process.stderr.write("unexpected fake db call\\n");
    return 1;
  },
});
registerErd(program);
await program.parseAsync(process.argv);
`,
	);
	await buildSkillsCli({ outfile: binary, entrypoint });
}, 240_000);

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("compiled dg-skills erd from an external cwd", () => {
	test("generates through current-binary db self-dispatch with no legacy command on PATH", async () => {
		const outBase = join(root, "artifacts", "map");
		const proc = Bun.spawn([binary, "erd", "generate", ".", "--type", "flow", "--out", outBase], {
			cwd,
			env: { ...process.env, PATH: emptyPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code, stderr).toBe(0);
		const result = JSON.parse(stdout) as { outPath: string };
		expect(readFileSync(result.outPath, "utf8")).toContain("graph LR");
		expect(stderr).toBe("");
	});

	test("generates a real ER diagram from the fake live-schema self-dispatch", async () => {
		const outBase = join(root, "artifacts", "schema");
		const proc = Bun.spawn([binary, "erd", "generate", ".", "--type", "er", "--out", outBase], {
			cwd,
			env: { ...process.env, PATH: emptyPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code, stderr).toBe(0);
		const result = JSON.parse(stdout) as { outPath: string; stats: { dbNodes: number } };
		expect(result.stats.dbNodes).toBeGreaterThanOrEqual(1);
		const markdown = readFileSync(result.outPath, "utf8");
		expect(markdown).toContain("erDiagram");
		expect(markdown).toContain("public_widgets");
		expect(stderr).toBe("");
	});
});
