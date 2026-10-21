import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	loadConfig,
	REACTION_DEFAULTS,
	resolveEnv,
} from "../../channel-review/src/config";
import { ERROR_CATALOG } from "../../channel-review/src/errors";
import { helpText } from "../../channel-review/src/help";
import { RUNNER_NAMES } from "../../channel-review/src/runners/types";
import { REPO_ROOT, readRepoFile } from "./test-support";

const TARGET_VERSION: string = JSON.parse(
	readRepoFile(".claude-plugin/plugin.json"),
).version;
const skillRoot = join(REPO_ROOT, "plugins/dg/skills/channel-review");
const inboxSkillPath = join(
	REPO_ROOT,
	"plugins/dg/skills/inbox-cleanup/SKILL.md",
);

const readSkill = () => readFileSync(join(skillRoot, "SKILL.md"), "utf8");
const readRef = (name: string) =>
	readFileSync(join(skillRoot, "references", name), "utf8");

function skillLinks(skill: string): string[] {
	return [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]);
}

function allContent(): string {
	const skill = readSkill();
	return [
		skill,
		...skillLinks(skill).map((p) => readFileSync(join(skillRoot, p), "utf8")),
		readRef("setup.md"),
		readRef("commands.md"),
	].join("\n");
}

function bootstrapBlock(skill: string): string {
	const lines = skill.split("\n");
	const start = lines.indexOf("```sh");
	const end = lines.indexOf("```", start + 1);
	return lines.slice(start, end + 1).join("\n");
}

function tableRows(markdown: string): string[][] {
	return markdown
		.split("\n")
		.filter((line) => /^\|.*\|\s*$/.test(line))
		.map((line) =>
			line
				.trim()
				.slice(1, -1)
				.split(/(?<!\\)\|/)
				.map((cell) => cell.replaceAll("\\|", "|").trim()),
		);
}

const TOKEN = /[$~][a-z][a-z-]*/g;

function section(markdown: string, heading: string): string {
	const start = markdown.indexOf(`\n${heading}\n`);
	expect(start).toBeGreaterThan(-1);
	const rest = markdown.slice(start + heading.length + 2);
	const end = rest.search(/^#{1,3} /m);
	return end === -1 ? rest : rest.slice(0, end);
}

function stripTicks(cell: string): string {
	return cell.replace(/^`([\s\S]*)`$/, "$1");
}

const cliSource = readRepoFile(
	"pkg",
	"skills-cli",
	"src",
	"commands",
	"channel-review.ts",
);
const emojisSource = readRepoFile("pkg", "channel-review", "src", "emojis.ts");
const configSource = readRepoFile("pkg", "channel-review", "src", "config.ts");

function declaredCommands(source: string): string[] {
	return [...source.matchAll(/\.command\("([^"]+)"\)/g)].map((m) => m[1]);
}

function declaredFlags(...sources: string[]): string[] {
	const flags = sources.flatMap((source) => [
		...source.matchAll(
			/(?:\.option|new Option)\(\s*"(?:-[a-z], )?(--[a-z][a-z-]*)/g,
		),
	]);
	return [...new Set(flags.map((m) => m[1]))];
}

describe("channel-review skill distribution", () => {
	test("both plugin hosts discover channel-review through the canonical shared tree", () => {
		expect(existsSync(join(skillRoot, "SKILL.md"))).toBe(true);
		const claude = JSON.parse(readRepoFile(".claude-plugin", "plugin.json"));
		const codex = JSON.parse(
			readRepoFile("plugins/dg/.codex-plugin/plugin.json"),
		);
		expect(
			claude.skills.map((path: string) => resolve(REPO_ROOT, path)),
		).toContain(resolve(skillRoot, ".."));
		expect(resolve(REPO_ROOT, "plugins/dg", codex.skills)).toBe(
			resolve(skillRoot, ".."),
		);
	});

	test("SKILL.md stays short, link-driven, and points only at references that exist", () => {
		const skill = readSkill();
		expect(skill.split("\n").length).toBeLessThanOrEqual(80);
		const links = skillLinks(skill);
		expect(links).toContain("references/setup.md");
		expect(links).toContain("references/commands.md");
		expect(links).toContain("references/relay-setup.md");
		expect(links).toContain("references/config.example.json");
		for (const link of links)
			expect(existsSync(join(skillRoot, link))).toBe(true);
	});

	test("frontmatter carries only name and description", () => {
		const front = /^---\n([\s\S]*?)\n---\n/.exec(readSkill())?.[1] ?? "";
		const keys = front
			.split("\n")
			.filter((line) => /^[a-z-]+:/.test(line))
			.map((line) => line.split(":")[0]);
		expect(keys).toEqual(["name", "description"]);
		expect(front).toMatch(/^name: channel-review$/m);
	});

	test("bootstrap block gates on help, installs the CLI only, ends with the help line", () => {
		const block = bootstrapBlock(readSkill()).split("\n");
		expect(block).toEqual([
			"```sh",
			"~/.dg/bin/dg-skills channel-review --help >/dev/null 2>&1 ||",
			expect.stringMatching(/bootstrap\.sh \| sh -s -- --cli-only$/),
			"~/.dg/bin/dg-skills channel-review --help",
			"```",
		]);
	});

	test("SKILL.md and references name the shipped CLI, commands, and vocabulary", () => {
		const content = allContent();
		expect(content).toContain(".dg/bin/dg-skills");
		expect(content).toMatch(/bootstrap\.sh/);
		for (const word of [
			"start",
			"stop",
			"status",
			"env",
			"emojis",
			"emojis set",
			"emojis show",
			"capture",
			"CR-101",
			"CR-104",
			"CR-201",
			"CR-205",
			"CR-206",
			"CR-303",
			"CR-304",
			"Go to production",
			"--env prod",
			"--env dev",
			"example-prod",
			"re-review",
			"ptal",
			"glab",
			"experimental",
			"~stacked",
			"~fun",
			"~agent",
			"~spice",
			"~comment",
			"~no-ci",
			"$review",
			"$address",
			"$help $address",
			"$emoji",
			"$help $emoji",
			"CR-107",
			"owner.senderIds",
			"address.allowAnySender",
			"address.cloneRoot",
			"Find your sender id",
			"remote:up",
			"remote:logs",
			"CR-105",
			"CR-106",
			"CR-305",
			"CR-306",
			"$thrash",
			"!owner",
			"rereview.phrases",
			"fun.pool",
			"hosts.github",
			"hosts.gitlab",
			"Review Bot",
			"Team Reviews",
			"mention",
			"thrash",
			"service mailbox",
			"Copy link",
			"0-<region>-d",
		])
			expect(content).toContain(word);
	});

	test("SKILL.md names every operation and the fun-pool review wording matches the open gate", () => {
		const skill = readSkill();
		for (const name of [
			"start",
			"stop",
			"status",
			"logs",
			"run",
			"env",
			"emojis",
		])
			expect(skill).toMatch(new RegExp(`channel-review ${name}\\b`));
		expect(allContent()).toMatch(
			/reviewed by the maintainer before each release|human-approved/,
		);
	});

	test("the Go to production checklist lists the four ordered steps", () => {
		const skill = readSkill();
		const section = skill.slice(skill.indexOf("Go to production"));
		const positions = [
			/prod bot/,
			/aws sso login --profile/,
			/status --env prod/,
			/start --env prod/,
			/channel-review env prod/,
		].map((pattern) => section.search(pattern));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	test("SKILL.md states platform support and the Windows stop behavior", () => {
		const skill = readSkill();
		for (const platform of ["Linux", "macOS", "WSL", "Windows"])
			expect(skill).toContain(platform);
		expect(skill).toContain("CR-205");
	});

	test("docs describe emojis capture matching its own prompt and deploys dropping the stream", () => {
		const commands = readRef("commands.md");
		expect(commands).toMatch(/capture[\s\S]{0,400}own prompt/i);
		expect(commands).toMatch(/stop and start/i);
		expect(allContent()).toMatch(/deploy[\s\S]{0,300}(stream|replay|gap)/i);
	});

	test("docs never leak repository sources, chat-harness names, or personal paths", () => {
		const content = allContent();
		for (const banned of [
			"src/index.ts",
			"dg-agent",
			"~/scripts",
			"/home/",
			"--config",
			"${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src",
			"bun run cli",
		])
			expect(content).not.toContain(banned);
	});
});

describe("channel-review docs do not drift from the shipped CLI", () => {
	test("help and runner documentation list every selectable backend", () => {
		const reviewHelp = helpText("Review Bot", "!owner", ["ready"], REACTION_DEFAULTS, {
			topic: "review",
		});
		const commands = readRef("commands.md");
		const setup = readRef("setup.md");
		for (const name of RUNNER_NAMES) {
			expect(reviewHelp).toContain(name);
			expect(commands).toContain(name);
			expect(setup).toContain(`| ${name} |`);
			expect(ERROR_CATALOG["CR-103"]).toContain(name);
		}
	});

	const content = () => allContent();

	test("every subcommand and flag the CLI registers is documented", () => {
		const commands = readRef("commands.md");
		const top = declaredCommands(cliSource).filter(
			(n) => n !== "channel-review",
		);
		expect(top).toEqual([
			"start",
			"stop",
			"status",
			"logs",
			"run",
			"connect",
			"migrate-env",
			"env",
		]);
		const emojis = declaredCommands(emojisSource);
		expect(emojis).toEqual(["capture", "set", "show"]);
		for (const name of top)
			expect(content()).toMatch(new RegExp(`channel-review ${name}\\b`));
		for (const name of emojis)
			expect(content()).toMatch(new RegExp(`emojis ${name}\\b`));
		const flags = declaredFlags(cliSource, emojisSource);
		expect([...flags].sort()).toEqual(
			[
				"--chat-id",
				"--dry-run",
				"--env",
				"--file",
				"--follow",
				"--keep-backup",
				"--lines",
				"--org",
				"--paste",
				"--runner",
				"--session",
				"--site",
				"--slot",
				"--timeout",
			].sort(),
		);
		for (const flag of flags) expect(commands).toContain(flag);
	});

	test("no documented dg-skills channel-review command or flag is one the CLI lacks", () => {
		const top = declaredCommands(cliSource).filter(
			(n) => n !== "channel-review",
		);
		const emojis = declaredCommands(emojisSource);
		const flags = new Set([
			...declaredFlags(cliSource, emojisSource),
			"--help",
		]);
		const lines = content()
			.split("\n")
			.filter((line) => /dg-skills\s+channel-review/.test(line));
		expect(lines.length).toBeGreaterThan(5);
		for (const line of lines) {
			const sub = /channel-review\s+([a-z-]+)(?:\s+([a-z]+))?/.exec(line);
			if (sub && !sub[1].startsWith("-")) {
				expect([...top, "emojis"]).toContain(sub[1]);
				if (sub[1] === "emojis" && sub[2] && !sub[2].startsWith("-"))
					expect(emojis).toContain(sub[2]);
			}
			for (const flag of line.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g))
				expect([...flags]).toContain(flag[1]);
		}
	});

	test.each([
		["overview", "### Commands", 5],
		["review", "### Review flags", 9],
		["address", "### Address flags", 4],
	] as const)(
		"the $help %s section and the commands.md %s table list the same tokens",
		(topic, heading, size) => {
			const help = helpText("Review Bot", "!owner", ["ready"], REACTION_DEFAULTS, { topic });
			const helpTokens = new Set(help.match(TOKEN) ?? []);
			const documented = new Set(
				tableRows(section(readRef("commands.md"), heading)).flatMap((cells) =>
					stripTicks(cells[0] ?? "").match(/^[$~]/)
						? ((cells[0] ?? "").match(TOKEN) ?? [])
						: [],
				),
			);
			expect(helpTokens.size).toBe(size);
			expect([...documented].sort()).toEqual([...helpTokens].sort());
		},
	);

	test("the $help $emoji slots and the commands.md emoji slot table list the same slots", () => {
		const help = helpText("Review Bot", "!owner", ["ready"], REACTION_DEFAULTS, {
			topic: "emoji",
		});
		const helpSlots = [...help.matchAll(/<li><code>(\w+)<\/code>/g)].map(
			(m) => m[1],
		);
		const documented = tableRows(
			section(readRef("commands.md"), "### Emoji command"),
		)
			.map((cells) => /^`(\w+)`/.exec(cells[0] ?? "")?.[1])
			.filter((slot): slot is string => slot !== undefined);
		expect(helpSlots.sort()).toEqual(Object.keys(REACTION_DEFAULTS).sort());
		expect(documented.sort()).toEqual(helpSlots.sort());
	});

	test("commands.md lists every error code with the exact catalog template", () => {
		const commands = readRef("commands.md");
		const rows = tableRows(commands)
			.filter((cells) => /^CR-\d{3}$/.test(stripTicks(cells[0] ?? "")))
			.map((cells) => [stripTicks(cells[0]), stripTicks(cells[1] ?? "")]);
		const documented = Object.fromEntries(rows);
		expect(Object.keys(documented).sort()).toEqual(
			Object.keys(ERROR_CATALOG).sort(),
		);
		expect(rows.length).toBe(Object.keys(ERROR_CATALOG).length);
		for (const [code, template] of Object.entries(ERROR_CATALOG))
			expect(documented[code]).toBe(template);
	});

	test("the placeholders agent, minutes, and owner appear literally in the table", () => {
		const commands = readRef("commands.md");
		for (const placeholder of ["{agent}", "{minutes}", "{owner}"])
			expect(commands).toContain(placeholder);
	});

	test("documented reaction defaults equal the defaults in config.ts", () => {
		const commands = readRef("commands.md");
		const block = /REACTION_DEFAULTS = \{([\s\S]*?)\};/.exec(configSource)?.[1];
		expect(block).toBeDefined();
		const defaults = [...(block ?? "").matchAll(/(\w+):\s*"([^"]+)"/g)];
		expect(defaults.length).toBe(6);
		for (const [, key, id] of defaults) {
			expect(commands).toContain(id);
			expect(allContent()).toContain(key);
		}
	});

	test("setup.md documents every env setting and the defaults from config.ts", () => {
		const setup = readRef("setup.md");
		const settings = /EnvSettings = \{([^}]*)\}/.exec(configSource)?.[1] ?? "";
		const keys = [...settings.matchAll(/(\w+): string/g)].map((m) => m[1]);
		expect(keys).toEqual(["baseUrl", "awsProfile", "botName"]);
		for (const key of keys) expect(setup).toContain(`\`${key}\``);
		const timeout = /rec\.timeoutMinutes \?\? (\d+)/.exec(configSource)?.[1];
		expect(timeout).toBeDefined();
		expect(setup).toMatch(new RegExp(`\\b${timeout}\\b`));
		const phrases = /REREVIEW_PHRASES = \[([\s\S]*?)\]/.exec(configSource)?.[1];
		for (const [, phrase] of (phrases ?? "").matchAll(/"([^"]+)"/g))
			expect(setup).toContain(phrase);
	});

	test("every key in the setup.md config table is real and every config key is listed", () => {
		const setup = readRef("setup.md");
		const keys = tableRows(setup)
			.map((cells) => stripTicks(cells[0] ?? ""))
			.filter((cell) =>
				/^(provider|env|envs|chats?|owner|runner|reactions|relay|fun|rereview|hosts|address)\b/.test(
					cell,
				),
			);
		for (const required of [
			"provider",
			"env.default",
			"envs.<name>",
			"chats",
			"chat",
			"owner.token",
			"owner.email",
			"owner.senderIds",
			"runner.default",
			"runner.fallback",
			"runner.timeoutMinutes",
			"runner.addressTimeoutMinutes",
			"runner.claude.allowedTools",
			"runner.claude.addressAllowedTools",
			"runner.<name>.path",
			"reactions.*",
			"relay.*",
			"fun.pool",
			"rereview.phrases",
			"hosts.github",
			"hosts.gitlab",
			"address.cloneRoot",
			"address.allowAnySender",
		])
			expect(keys).toContain(required);
		for (const key of keys)
			for (const segment of key.split(".")) {
				if (segment === "*" || segment.startsWith("<")) continue;
				expect(configSource).toMatch(new RegExp(`\\b${segment}\\b`));
			}
		for (const rule of [
			"Bash(<home>/.dg/bin/dg-skills thrash:*)",
			"Read(//<scratch>/thrash/**)",
			"Grep(//<scratch>/thrash/**)",
			"Glob(//<scratch>/thrash/**)",
			"Edit(//<scratch>/thrash/**)",
		])
			expect(setup).toContain(rule);
		expect(setup).not.toContain("<home>/scripts/**");
		expect(setup).not.toMatch(/scripts\/bin|-helper|~\/\.claude\/skills/);
		for (const rule of [
			"Edit(//<clones>/**)",
			"Read(//<clones>/**)",
			"Grep(//<clones>/**)",
			"Glob(//<clones>/**)",
			"Bash(<home>/.dg/bin/dg-skills address:*)",
		])
			expect(setup).toContain(rule);
		const address =
			/addressAllowedTools \?\? \[([\s\S]*?)\];/.exec(configSource)?.[1] ?? "";
		for (const [, tool] of address.matchAll(/"Bash\((\w+):\*\)"/g))
			expect(setup).toContain(`\`${tool}\``);
		expect(
			/rec\.addressTimeoutMinutes \?\? (\d+)/.exec(configSource)?.[1],
		).toBe("60");
		expect(setup).toContain("`<home>/code/bot`");
		expect(configSource).toContain(".dg/bin/dg-skills");
		expect(setup).toContain("dg-skills deps-upgrade");
		for (const name of ["thrash", "address", "deps-upgrade"])
			expect(setup).toContain(
				`Read(~/.claude/plugins/cache/*/dg/*/plugins/dg/skills/${name}/**)`,
			);
		expect(setup).not.toContain(
			"`.copilot/skills/thrash/SKILL.md` or `.claude/skills/thrash/SKILL.md`",
		);
	});

	test("setup.md documents chats, the shared queue, and the per-chat status fields", () => {
		const setup = readRef("setup.md");
		for (const word of ["chats", "share one review queue", "lastEventIds"])
			expect(setup).toContain(word);
		expect(setup).toMatch(/`chat`[^\n]*still works/);
		expect(configSource).toContain('"chats"');
	});

	test("setup.md covers prerequisites, state locations, and the secret handling", () => {
		const setup = readRef("setup.md");
		for (const word of [
			"Prerequisites",
			"gh",
			"glab",
			"aws",
			"thrash",
			"DG_HOME/channel-review",
			"CR-206",
			"allowedTools",
			"relay-setup.md",
		])
			expect(setup).toContain(word);
		expect(setup).toMatch(/never written|not written|never stored/i);
	});
});

describe("channel-review example config and relay docs", () => {
	const examplePath = join(skillRoot, "references", "config.example.json");

	test("config.example.json loads with loadConfig and resolves both envs", () => {
		const config = loadConfig(examplePath);
		for (const name of ["dev", "prod"]) {
			const env = resolveEnv(config, name);
			expect(env.baseUrl).toStartWith("https://relay.example.test/");
			expect(env.botName).toContain("Review Bot");
		}
		expect(config.relay.secret).toEqual({
			id: "relay/chat",
			key: "RELAY__CHAT__SECRET",
			region: "us-east-1",
		});
	});

	test("setup.md links relay-setup.md and relay-setup.md points at the relay contract", () => {
		expect(readRef("setup.md")).toContain("(relay-setup.md)");
		const guide = readRef("relay-setup.md");
		expect(guide).toContain("pkg/channel-review/README.md");
		expect(guide).toContain("config.example.json");
		expect(existsSync(join(REPO_ROOT, "pkg/channel-review/README.md"))).toBe(
			true,
		);
	});
});

describe("channel-review release wiring", () => {
	test("skills-cli depends on the channel-review workspace package", () => {
		const cli = JSON.parse(readRepoFile("pkg/skills-cli/package.json"));
		expect(cli.dependencies["@dg/channel-review"]).toBe("workspace:*");
	});

	test("both skills workflows watch the channel-review sources", () => {
		for (const name of ["skills-release.yml", "skills-blt.yml"])
			expect(readRepoFile(".github/workflows", name)).toContain(
				"- pkg/channel-review/**",
			);
	});

	test("every released package, the daemon constant, and both manifests sit at the target version", () => {
		for (const pkg of ["extension", "dg-daemon", "dg-agent", "skills-cli"])
			expect(JSON.parse(readRepoFile("pkg", pkg, "package.json")).version).toBe(
				TARGET_VERSION,
			);
		const status = readRepoFile("pkg/dg-daemon/src/server/status.ts");
		expect(/DG_DAEMON_PACKAGE_VERSION = "([^"]+)"/.exec(status)?.[1]).toBe(
			TARGET_VERSION,
		);
		const claude = JSON.parse(readRepoFile(".claude-plugin/plugin.json"));
		const codex = JSON.parse(
			readRepoFile("plugins/dg/.codex-plugin/plugin.json"),
		);
		const cli = JSON.parse(readRepoFile("pkg/skills-cli/package.json"));
		expect(claude.version).toBe(cli.version);
		expect(codex.version).toBe(cli.version);
		expect(claude.version).toBe(TARGET_VERSION);
	});

	test("manifests describe channel review and ship its default prompt", () => {
		const claude = JSON.parse(readRepoFile(".claude-plugin/plugin.json"));
		const codex = JSON.parse(
			readRepoFile("plugins/dg/.codex-plugin/plugin.json"),
		);
		expect(claude.keywords).toEqual(
			expect.arrayContaining(["teams", "review"]),
		);
		expect(codex.keywords).toBeUndefined();
		expect(claude.description).toMatch(/channel review/i);
		expect(codex.interface.longDescription).toMatch(/channel review/i);
		expect(codex.interface.shortDescription).toMatch(/channel review/i);
		expect(codex.interface.defaultPrompt).toContain(
			"Start the channel review daemon",
		);
		expect(claude.description).toBe(codex.description);
		expect(claude.description).toBe(codex.interface.longDescription);
	});
});

describe("channel-review catalog entries", () => {
	test("the skills README lists channel-review in the table and tree without a blank row gap", () => {
		const readme = readRepoFile("plugins/dg/skills/README.md");
		expect(readme).toMatch(/^\| `channel-review\/` \|/m);
		expect(readme).toMatch(/^ {2}channel-review\/$/m);
		expect(readme).not.toMatch(/\| `chat\/` \|[^\n]*\n\n\|/);
		const rows = readme.split("\n").filter((l) => l.startsWith("| `"));
		const names = rows.map((l) => /`([^`]+)`/.exec(l)?.[1]);
		expect(names.indexOf("channel-review/")).toBe(
			names.indexOf("inbox-cleanup/") + 1,
		);
	});

	test("the root README names channel review and links its topic guide after inbox cleanup", () => {
		const readme = readRepoFile("README.md");
		const intro = readme.split("\n").slice(0, 5).join("\n");
		expect(intro).toMatch(/channel review/i);
		const inbox = readme.indexOf("[Inbox cleanup](docs/inbox-cleanup.md)");
		const channel = readme.indexOf("[Channel review](docs/channel-review.md)");
		expect(inbox).toBeGreaterThan(-1);
		expect(channel).toBeGreaterThan(inbox);
		const guide = readRepoFile("docs/channel-review.md");
		expect(guide).toContain("$dg:channel-review");
		expect(guide).toContain("../pkg/channel-review/README.md");
	});

	test("AGENT-INSTALL lists the skill, the human-only steps, and the agent-safe commands", () => {
		const doc = readRepoFile("docs/AGENT-INSTALL.md");
		const codexLine = doc
			.split("\n")
			.find((l) => l.includes("$CODEX_HOME/skills"));
		expect(codexLine).toContain("channel-review");
		for (const word of [
			"aws sso login --profile",
			"Review Bot",
			"emojis capture",
			"emojis show",
			"emojis set",
			"status",
			"GIF",
		])
			expect(doc).toContain(word);
	});

	test("DEVELOPER documents the layout, the integration, and both CI path rows", () => {
		const doc = readRepoFile("docs/DEVELOPER.md");
		expect(doc).toMatch(/channel-review\//);
		expect(doc).toMatch(/## Channel review/i);
		const ciRows = doc
			.split("\n")
			.filter((l) => /skills-blt|skills-release/.test(l));
		expect(ciRows.length).toBeGreaterThanOrEqual(2);
		for (const row of ciRows) expect(row).toContain("channel-review");
	});

	test("the skills-cli README has a Channel review section naming the commands", () => {
		const doc = readRepoFile("pkg/skills-cli/README.md");
		const section = doc.slice(doc.indexOf("## Channel review"));
		expect(doc).toContain("## Channel review");
		for (const word of [
			"channel-review",
			"status",
			"emojis",
			"references/setup.md",
		])
			expect(section).toContain(word);
	});
});

test("review attribution docs distinguish execution origin from worker models", () => {
	const commands = readRepoFile(
		"plugins/dg/skills/channel-review/references/commands.md",
	);
	for (const label of [
		"Automatic (daemon)",
		"Manual (CLI)",
		"orchestrator",
		"worker",
	])
		expect(commands).toContain(label);
	const developer = readRepoFile("docs/DEVELOPER.md");
	for (const field of [
		"THRASH_EXECUTION_CONTEXT",
		"modelSource",
		"attribution.md",
	])
		expect(developer).toContain(field);
});
