import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelReviewPaths, createStateStore } from "@dg/channel-review";
import { skillsEntry } from "./inbox-cli-harness";
import { mergeEnv } from "./module-call";

type Result = { code: number; stdout: string; stderr: string };

let cwd: string;
let dgHome: string;

const ENVS = {
	dev: { baseUrl: "https://relay.example.test/dev/api", awsProfile: "example-dev", botName: "Review Bot" },
	prod: { baseUrl: "https://relay.example.test/prod/api", awsProfile: "example-prod", botName: "Review Bot" },
};

const BASE_CONFIG = {
	envs: ENVS,
	chats: [{ topic: "Team Reviews" }],
	owner: { token: "!owner", email: "owner@example.com" },
	relay: {
		appName: "review-bot",
		secret: { id: "relay/chat", key: "RELAY__CHAT__SECRET", region: "us-east-1" },
	},
};

const configPath = () => join(dgHome, "channel-review", "config.json");

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "dg-channel-review-cli-"));
	dgHome = join(cwd, "dg-home");
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

async function run(args: string[], overrides: Record<string, string | undefined> = {}): Promise<Result> {
	const proc = Bun.spawn([process.execPath, skillsEntry, "channel-review", ...args], {
		cwd,
		env: mergeEnv({
			DG_HOME: dgHome,
			PATH: join(cwd, "empty-bin"),
			...overrides,
		}),
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), 30_000);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { code, stdout, stderr };
}

function writeConfig(body: Record<string, unknown> = {}): void {
	mkdirSync(join(dgHome, "channel-review"), { recursive: true });
	writeFileSync(
		configPath(),
		`${JSON.stringify({ ...BASE_CONFIG, ...body }, null, "\t")}\n`,
	);
}

describe("channel-review help", () => {
	test("lists start, stop, status, logs, run, and env", async () => {
		const result = await run(["--help"]);
		expect(result.code).toBe(0);
		for (const name of ["start", "stop", "status", "logs", "run", "env"]) {
			expect(result.stdout).toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
		}
	});

	test.each(["start", "stop", "status", "logs", "run", "env"])("%s --help exits 0", async (name) => {
		const result = await run([name, "--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(name);
	});

	test("start and run document --env, --runner, and --chat-id", async () => {
		for (const name of ["start", "run"]) {
			const { stdout } = await run([name, "--help"]);
			expect(stdout).toContain("--env");
			expect(stdout).toContain("--runner");
			expect(stdout).toContain("--chat-id");
		}
	});

	test("stop and status document --env", async () => {
		for (const name of ["stop", "status"]) {
			expect((await run([name, "--help"])).stdout).toContain("--env");
		}
	});

	test("there is no --config flag", async () => {
		const result = await run(["status", "--config", "x.json"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("--config");
	});
});

describe("channel-review env", () => {
	test("with no argument and no config prints the default env dev and the config error", async () => {
		const result = await run(["env"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("default env: dev");
		expect(result.stdout).not.toContain("base URL");
		expect(result.stderr).toContain(configPath());
	});

	test("with no argument prints the base URL and AWS profile from the config", async () => {
		writeConfig();
		const result = await run(["env"]);
		expect(result.stdout).toContain("default env: dev");
		expect(result.stdout).toContain(ENVS.dev.baseUrl);
		expect(result.stdout).toContain(ENVS.dev.awsProfile);
	});

	test("env staging exits 1 naming dev and prod", async () => {
		const result = await run(["env", "staging"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("dev");
		expect(result.stderr).toContain("prod");
	});

	test("env prod rewrites env.default and prints the new default", async () => {
		writeConfig();
		const result = await run(["env", "prod"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("prod");
		expect(JSON.parse(readFileSync(configPath(), "utf8")).env.default).toBe("prod");
	});

	test("env prod creates a config file holding only the default when none exists", async () => {
		const result = await run(["env", "prod"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({ env: { default: "prod" } });
	});

	test("with no argument after env prod prints prod and the prod settings", async () => {
		writeConfig();
		await run(["env", "prod"]);
		const result = await run(["env"]);
		expect(result.stdout).toContain("default env: prod");
		expect(result.stdout).toContain(ENVS.prod.baseUrl);
		expect(result.stdout).toContain(ENVS.prod.awsProfile);
	});
});

describe("channel-review status", () => {
	test("without config.json prints running false and a config error naming the path, exit 1", async () => {
		const result = await run(["status"]);
		expect(result.code).toBe(1);
		const body = JSON.parse(result.stdout);
		expect(body).toMatchObject({ env: "dev", running: false });
		expect(body.preflight.config.error).toContain(configPath());
	});

	test("status reads each environment from daemon.db across CLI processes", async () => {
		const dev = channelReviewPaths("dev", { env: { DG_HOME: dgHome } });
		const prod = channelReviewPaths("prod", { env: { DG_HOME: dgHome } });
		for (const paths of [dev, prod]) {
			const store = createStateStore(paths);
			store.setLastEventId("chat", `${paths.env}-cursor`);
			store.setCurrent({ messageId: `${paths.env}-request`, chatId: "chat", url: "https://github.com/example/app/pull/1", number: 1, startedAt: new Date().toISOString(), pid: 1234, pidStart: "start-1234" });
			store.close();
		}
		for (const env of ["dev", "prod"]) {
			const result = await run(["status", "--env", env]);
			const body = JSON.parse(result.stdout);
			expect(result.code).toBe(1);
			expect(body.lastEventIds).toEqual({ chat: `${env}-cursor` });
			expect(body.current).toMatchObject({ messageId: `${env}-request`, pid: 1234, pidStart: "start-1234" });
		}
	});

	test("with config and no stored secret it reports env dev, running false, runner probes, and a preflight secret error", async () => {
		writeConfig();
		const result = await run(["status"]);
		expect(result.code).toBe(1);
		const body = JSON.parse(result.stdout);
		expect(body).toMatchObject({
			env: "dev",
			running: false,
			runners: { claude: "CR-201", codex: "CR-201", copilot: "CR-201", grok: "CR-201" },
		});
		expect(body.logPath).toBe(join(dgHome, "channel-review", "daemon.dev.log"));
		expect(body.preflight.secret.error).toContain("connect relay --env dev");
	});

	test("status --env prod names env prod and uses the prod paths", async () => {
		writeConfig();
		const body = JSON.parse((await run(["status", "--env", "prod"])).stdout);
		expect(body.env).toBe("prod");
		expect(body.logPath).toBe(join(dgHome, "channel-review", "daemon.prod.log"));
	});

	test("a status without --env reports prod after env prod", async () => {
		writeConfig();
		await run(["env", "prod"]);
		const body = JSON.parse((await run(["status"])).stdout);
		expect(body.env).toBe("prod");
	});
});

describe("channel-review logs", () => {
	const logPath = (env = "dev") => join(dgHome, "channel-review", `daemon.${env}.log`);
	const writeLog = (text: string, env = "dev") => {
		mkdirSync(join(dgHome, "channel-review"), { recursive: true });
		writeFileSync(logPath(env), text);
	};

	test("--help documents --env, -n, --lines, and -f, --follow", async () => {
		const { stdout } = await run(["logs", "--help"]);
		for (const flag of ["--env", "-n, --lines", "-f, --follow"]) {
			expect(stdout).toContain(flag);
		}
	});

	test("with no log file prints the path and no log yet, exit 0", async () => {
		const result = await run(["logs"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(logPath());
		expect(result.stdout).toContain("no log yet");
	});

	test("prints the last 40 lines by default", async () => {
		writeLog(`${Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
		const result = await run(["logs"]);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(40);
		expect(lines[0]).toBe("line 21");
		expect(lines.at(-1)).toBe("line 60");
	});

	test("-n limits the lines and --env prod reads the prod log", async () => {
		writeLog("a\nb\nc\n", "prod");
		const result = await run(["logs", "--env", "prod", "-n", "2"]);
		expect(result.stdout.trimEnd().split("\n")).toEqual(["b", "c"]);
	});

	test("a non-numeric -n exits 1 naming --lines", async () => {
		writeLog("a\n");
		const result = await run(["logs", "-n", "abc"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--lines");
	});

	test("--follow prints new lines until it receives SIGINT, then exits 0", async () => {
		writeLog("first\n");
		const proc = Bun.spawn([process.execPath, skillsEntry, "channel-review", "logs", "-f"], {
			cwd,
			env: mergeEnv({ DG_HOME: dgHome, PATH: join(cwd, "empty-bin") }),
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let seen = "";
		const readUntil = async (text: string) => {
			const deadline = Date.now() + 15_000;
			while (!seen.includes(text) && Date.now() < deadline) {
				const next = await reader.read();
				if (next.done) break;
				seen += decoder.decode(next.value);
			}
			expect(seen).toContain(text);
		};
		await readUntil("first");
		appendFileSync(logPath(), "second\n");
		await readUntil("second");
		proc.kill("SIGINT");
		expect(await proc.exited).toBe(0);
	});
});

describe("channel-review start and stop", () => {
	test("start with no config.json exits 1 naming the config path", async () => {
		const result = await run(["start"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(configPath());
	});

	test("start without the aws CLI exits 1 naming aws", async () => {
		writeConfig();
		const result = await run(["start"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("aws");
	});

	test("stop when nothing runs exits 0 with not running", async () => {
		const result = await run(["stop"]);
		expect(result.code).toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain("not running");
	});

	test("stop --env prod when nothing runs exits 0 with not running", async () => {
		const result = await run(["stop", "--env", "prod"]);
		expect(result.code).toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain("not running");
	});
});

describe("channel-review emojis", () => {
	const EXPECTED_FORMAT = "name;0-<region>-d<digits>-<32hex>";
	const HEX = "0123456789abcdef0123456789abcdef";

	test("emojis --help lists capture, set, and show", async () => {
		const result = await run(["emojis", "--help"]);
		expect(result.code).toBe(0);
		for (const name of ["capture", "set", "show"]) {
			expect(result.stdout).toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
		}
	});

	test("emojis capture without --slot exits 1 naming the flag", async () => {
		writeConfig();
		const result = await run(["emojis", "capture"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--slot");
	});

	test("emojis set with a malformed id exits 1 and prints the expected format", async () => {
		writeConfig();
		const result = await run(["emojis", "set", "approved", "blob;0-cus-d9-xyz"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(EXPECTED_FORMAT);
		expect(JSON.parse(readFileSync(configPath(), "utf8")).reactions).toBeUndefined();
	});

	test("emojis set with a valid id saves it to reactions.approved and prints it", async () => {
		writeConfig();
		const id = `blob;0-cus-d3-${HEX}`;
		const result = await run(["emojis", "set", "approved", id]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(id);
		expect(JSON.parse(readFileSync(configPath(), "utf8")).reactions.approved).toBe(id);
	});

	test("emojis show prints both slots and marks the fallback", async () => {
		writeConfig();
		const result = await run(["emojis", "show"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("progress");
		expect(result.stdout).toContain("approved");
		expect(result.stdout).toContain("fallback");
	});

	test("emojis show without config.json exits 1 naming the config path", async () => {
		const result = await run(["emojis", "show"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(configPath());
	});
});
