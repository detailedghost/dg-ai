import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHelp } from "../src/cli/catalog";
import { accountHome, allowSendHome, runSsms } from "../src/cli/run";
import { createLocalMessagesBrowser } from "../src/google/browser";
import { connectJsonRpc } from "../src/signal/rpc";
import { asTextArea, createDocument, node, readyThread } from "./support/document";
import { startFakeSignalServer } from "./support/rpc";

function googleRuntime(home: string) {
	const doc = createDocument(
		[
			node("sale ends 50% off", { href: "/web/conversations/promo", "aria-label": "Shop" }),
			node("hello", {
				href: "/web/conversations/keep",
				"aria-label": "Ada",
				"aria-pressed": "true",
			}),
			node("Options"),
			node("Archive"),
			node("Delete"),
			(() => {
				const send = node("Send", { "aria-label": "Send" });
				send.paneId = "keep";
				return send;
			})(),
			(() => {
				const box = asTextArea(node("", { "aria-label": "Text message" }, "TEXTAREA"));
				box.paneId = "keep";
				return box;
			})(),
		],
		"Conversations",
	);
	readyThread(doc, "keep", "Ada");
	return {
		home,
		browser: createLocalMessagesBrowser(doc),
		ids: () => "draft-1",
		now: () => Date.parse("2026-10-31T00:00:00Z"),
		env: {},
		openTerminal: () => openSync("/dev/null", "w"),
	};
}

describe("ssms cli", () => {
	test("help lists both providers and the send gate", async () => {
		const result = await runSsms(["--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(renderHelp());
		for (const line of ["ssms <provider> link [--name NAME]", "ssms google cleanup [--dry-run] [--config PATH]", 			"ssms <provider> send --draft ID [--approve TOKEN]"]) {
			expect(result.stdout).toContain(line);
		}
		expect(result.stdout).toContain("google");
		expect(result.stdout).toContain("signal");
		expect(result.stdout).toContain("The token is shown on the terminal device only");
		expect(result.stdout).toContain("not from HOME or DG_HOME");
		expect(result.stdout).toContain("google.send_enabled defaults to false");
		expect(result.stdout).toContain("accidental and non-interactive sends");
		expect(result.stdout).not.toContain("A hook cannot send");
	});

	test("google cleanup archives the promo and does not delete or send", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-cli-"));
		const result = await runSsms(["google", "cleanup", "--json"], googleRuntime(home));
		expect(result.code).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.deleted).toBe(0);
		expect(body.actions.find((item: { id: string }) => item.id === "promo")).toMatchObject({
			disposition: "archive",
			applied: true,
		});
		expect(body.actions.find((item: { id: string }) => item.id === "keep").applied).toBe(false);
		expect(result.stderr).not.toContain("sale ends");
	});

	test("a draft is not sent until --yes, and a hook cannot send", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-draft-"));
		const runtime = { ...googleRuntime(home), configHome: home };
		const drafted = await runSsms(
			["google", "draft", "--conversation", "keep", "--text", "hello there"],
			runtime,
		);
		expect(drafted.code).toBe(0);
		expect(drafted.stdout).toContain("draft draft-1");
		expect(drafted.stdout).toContain("hello there");
		expect(drafted.stderr).not.toContain("hello there");
		mkdirSync(join(home, "ssms"), { recursive: true });
		writeFileSync(
			join(home, "ssms", "config.yaml"),
			"allow_send: true\ngoogle:\n  send_enabled: true\n",
		);
		const refused = await runSsms(["google", "send", "--draft", "draft-1"], runtime);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("interactive yes");
		expect(refused.stdout).not.toContain("sent ");
		let token = "";
		const revealed = await runSsms(
			["google", "draft", "--conversation", "keep", "--text", "hello there"],
			{ ...runtime, ids: () => "draft-2", revealToken: (_id, value) => { token = value; } },
		);
		expect(revealed.stdout).not.toContain(token);
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		const sent = await runSsms(
			["google", "send", "--draft", "draft-2", "--approve", token],
			runtime,
		);
		expect(sent.code).toBe(0);
		expect(sent.stdout).toContain("sent draft-2");
		expect(sent.stderr).not.toContain(token);
	});

	test("signal link output contains the URI and the log does not", async () => {
		const server = await startFakeSignalServer((method) => {
			if (method === "startLink") return { deviceLinkUri: "sgnl://linkdevice?uuid=abc&pub_key=SECRETKEY" };
			if (method === "finishLink") return { aci: "acct-1", number: "+15555550123" };
			throw new Error(method);
		});
		const rpc = await connectJsonRpc(server.port);
		const home = mkdtempSync(join(tmpdir(), "ssms-cli-signal-"));
		const result = await runSsms(["signal", "link", "--name", "dg-cli"], { home, rpc, env: {} });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("sgnl://linkdevice?uuid=abc&pub_key=SECRETKEY");
		expect(result.stdout.split("\n").some((line) => /[█▄▀]/.test(line))).toBe(true);
		expect(result.stderr).not.toContain("sgnl://");
		expect(result.stderr).not.toContain("SECRETKEY");
		expect(result.stderr).not.toContain("+15555550123");
		expect(server.calls[1]?.params).toMatchObject({ deviceName: "dg-cli" });
		await rpc.close();
		await server.close();
	});

	test("a missing signal-cli prints the install hint and does not spawn", async () => {
		let spawned = 0;
		const result = await runSsms(["signal", "status"], {
			env: {},
			which: () => null,
			exists: () => false,
			spawn: () => {
				spawned += 1;
				throw new Error("spawned");
			},
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("sudo pacman -S signal-cli");
		expect(result.stderr).toContain("will not install");
		expect(result.stderr).toContain("missing-binary");
		expect(spawned).toBe(0);
	});

	test("a hook that can only read stdout and the draft file cannot send", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-hook-"));
		mkdirSync(join(home, "ssms"), { recursive: true });
		writeFileSync(join(home, "ssms", "config.yaml"), "allow_send: true\n");
		const overlay = join(home, "hook.json");
		writeFileSync(overlay, JSON.stringify({ allow_send: true }));
		const runtime = {
			...googleRuntime(home),
			configHome: home,
			env: { CLAUDE_PROJECT_DIR: "/x", CLAUDE_CODE_ENTRYPOINT: "cli" },
			stdinIsTTY: false,
		};
		const drafted = await runSsms(
			["google", "draft", "--conversation", "keep", "--text", "hello there", "--json"],
			runtime,
		);
		expect(drafted.code).toBe(0);
		expect(drafted.stdout).not.toMatch(/--approve [0-9a-f]{32}/);
		expect(drafted.stdout).not.toMatch(/\b[0-9a-f]{32}\b/);
		expect(drafted.stdout).not.toContain("approvalToken");
		const bare = await runSsms(["google", "send", "--draft", "draft-1", "--yes"], runtime);
		expect(bare.code).toBe(1);
		expect(bare.stderr).toContain("hook");
		expect(bare.stdout).not.toContain("sent ");
		const file = readFileSync(join(home, "ssms", "drafts", "draft-1.json"), "utf8");
		expect(file).not.toContain("approvalToken\":");
		expect(file).toContain("approvalTokenHash");
		const leaked = [...`${drafted.stdout}\n${file}`.matchAll(/\b[0-9a-f]{32,64}\b/g)].map((match) => match[0]);
		for (const candidate of leaked) {
			const sent = await runSsms(
				["google", "send", "--draft", "draft-1", "--approve", candidate, "--yes"],
				runtime,
			);
			expect(sent.code).toBe(1);
			expect(sent.stdout).not.toContain("sent ");
		}
		const override = await runSsms(
			["google", "send", "--draft", "draft-1", "--config", overlay],
			runtime,
		);
		expect(override.code).toBe(1);
		expect(override.stderr).toContain("allow_send cannot be set with --config");
	});

	test("allow_send false never sends, even with a terminal yes", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-nosend-"));
		const runtime = {
			...googleRuntime(home),
			configHome: home,
			stdinIsTTY: true,
			ask: async () => true,
		};
		await runSsms(
			["google", "draft", "--conversation", "keep", "--text", "hello there"],
			runtime,
		);
		const sent = await runSsms(
			["google", "send", "--draft", "draft-1", "--yes"],
			runtime,
		);
		expect(sent.code).toBe(1);
		expect(sent.stderr).toContain("allow_send");
		expect(sent.stdout).not.toContain("sent ");
	});

	test("a declined prompt and a wrong token do not send", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-decline-"));
		mkdirSync(join(home, "ssms"), { recursive: true });
		writeFileSync(join(home, "ssms", "config.yaml"), "allow_send: true\n");
		const runtime = {
			...googleRuntime(home),
			configHome: home,
			stdinIsTTY: true,
			ask: async () => false,
		};
		await runSsms(["google", "draft", "--conversation", "keep", "--text", "hello there"], runtime);
		const declined = await runSsms(["google", "send", "--draft", "draft-1"], runtime);
		expect(declined.code).toBe(1);
		expect(declined.stderr).toContain("send declined");
		expect(declined.stdout).not.toContain("sent ");
		const wrong = await runSsms(
			["google", "send", "--draft", "draft-1", "--approve", "not-the-token"],
			{ ...runtime, ask: async () => true },
		);
		expect(wrong.code).toBe(1);
		expect(wrong.stderr).toContain("does not match");
		expect(wrong.stdout).not.toContain("sent ");
	});

	test("dry-run does not send the draft", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-dry-"));
		mkdirSync(join(home, "ssms"), { recursive: true });
		writeFileSync(join(home, "ssms", "config.yaml"), "allow_send: true\n");
		let token = "";
		const runtime = {
			...googleRuntime(home),
			revealToken: (_id: string, value: string) => {
				token = value;
			},
		};
		await runSsms(["google", "draft", "--conversation", "keep", "--text", "hello there"], runtime);
		const dry = await runSsms(
			["google", "send", "--draft", "draft-1", "--approve", token, "--dry-run"],
			runtime,
		);
		expect(dry.code).toBe(0);
		expect(dry.stdout).toContain("dry-run");
		expect(dry.stdout).not.toContain("sent ");
		const stored = readFileSync(join(home, "ssms", "drafts", "draft-1.json"), "utf8");
		expect(stored).toContain("\"pending\"");
	});

	test("DG_HOME cannot turn allow_send on", async () => {
		const evil = mkdtempSync(join(tmpdir(), "ssms-evil-"));
		const real = mkdtempSync(join(tmpdir(), "ssms-real-"));
		mkdirSync(join(evil, "ssms"), { recursive: true });
		writeFileSync(join(evil, "ssms", "config.yaml"), "allow_send: true\n");
		let token = "";
		const runtime = {
			...googleRuntime(evil),
			home: evil,
			env: { DG_HOME: evil },
			configHome: real,
			revealToken: (_id: string, value: string) => {
				token = value;
			},
		};
		const drafted = await runSsms(
			["google", "draft", "--conversation", "keep", "--text", "hello there"],
			runtime,
		);
		expect(drafted.code).toBe(0);
		const sent = await runSsms(
			["google", "send", "--draft", "draft-1", "--approve", token, "--yes"],
			runtime,
		);
		expect(sent.code).toBe(1);
		expect(sent.stderr).toContain("allow_send");
		expect(sent.stdout).not.toContain("sent ");
		expect(allowSendHome("/home/ada")).toBe(join("/home/ada", ".dg"));
	});

	test("allow_send uses the injected passwd home, not HOME", async () => {
		const homeViaEnv = mkdtempSync(join(tmpdir(), "ssms-home-env-"));
		const passwd = mkdtempSync(join(tmpdir(), "ssms-passwd-"));
		mkdirSync(join(homeViaEnv, ".dg", "ssms"), { recursive: true });
		writeFileSync(join(homeViaEnv, ".dg", "ssms", "config.yaml"), "allow_send: true\ngoogle:\n  send_enabled: true\n");
		mkdirSync(join(passwd, ".dg", "ssms"), { recursive: true });
		const previous = process.env.HOME;
		process.env.HOME = homeViaEnv;
		try {
			expect(accountHome(501, "darwin", (command, args) => {
				if (command === "id" && args[0] === "-P") {
					return "ada:*:501:20:staff:0:0:Ada:/Users/ada:/bin/zsh\n";
				}
				throw new Error(command);
			})).toBe("/Users/ada");
			expect(accountHome(501, "darwin", () => {
				throw new Error("missing");
			})).toBeUndefined();
			expect(allowSendHome()).not.toBe(join(homeViaEnv, ".dg"));
			let token = "";
			const runtime = {
				...googleRuntime(homeViaEnv),
				home: homeViaEnv,
				passwdHome: passwd,
				env: { HOME: homeViaEnv, DG_HOME: homeViaEnv },
				revealToken: (_id: string, value: string) => {
					token = value;
				},
			};
			const drafted = await runSsms(
				["google", "draft", "--conversation", "keep", "--text", "hello there"],
				runtime,
			);
			expect(drafted.code).toBe(0);
			const sent = await runSsms(
				["google", "send", "--draft", "draft-1", "--approve", token, "--yes"],
				runtime,
			);
			expect(sent.code).toBe(1);
			expect(sent.stderr).toContain("allow_send");
			expect(sent.stdout).not.toContain("sent ");
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
		}
	});

	test("google send stays disabled until google.send_enabled is set", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-gsend-"));
		mkdirSync(join(home, "ssms"), { recursive: true });
		writeFileSync(join(home, "ssms", "config.yaml"), "allow_send: true\n");
		let token = "";
		const runtime = {
			...googleRuntime(home),
			configHome: home,
			revealToken: (_id: string, value: string) => {
				token = value;
			},
		};
		await runSsms(["google", "draft", "--conversation", "keep", "--text", "hello there"], runtime);
		const sent = await runSsms(
			["google", "send", "--draft", "draft-1", "--approve", token],
			runtime,
		);
		expect(sent.code).toBe(1);
		expect(sent.stderr).toContain("google.send_enabled");
		expect(sent.stdout).not.toContain("sent ");
	});

	test("draft fails when the terminal cannot show the token", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-notty-"));
		const result = await runSsms(
			["google", "draft", "--conversation", "keep", "--text", "hello there"],
			{
				...googleRuntime(home),
				openTerminal: () => {
					throw new Error("ENXIO");
				},
			},
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("approval token not shown: no terminal");
		expect(result.stderr).not.toMatch(/\b[0-9a-f]{32}\b/);
		expect(result.stdout).not.toContain("draft draft-1");
		expect(existsSync(join(home, "ssms", "drafts", "draft-1.json"))).toBe(false);
	});

	test("delete is rejected", async () => {
		const result = await runSsms(["google", "delete"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("delete is disabled");
	});
});

describe("config file", () => {
	test("a yaml config forces dry-run", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-cfg-"));
		const config = join(home, "cleanup.yaml");
		writeFileSync(config, "dry_run: true\nallow_delete: true\n");
		const result = await runSsms(["google", "cleanup", "--config", config, "--json"], googleRuntime(home));
		expect(result.code).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.actions.every((item: { applied: boolean }) => item.applied === false)).toBe(true);
		expect(body.deleted).toBe(0);
		expect(body.allowDelete).toBe(true);
	});
});
