import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { CliRequest, SessionBootstrap } from "@dg/common";
import { openFailedHint } from "@dg/common/node";
import {
	bootServe,
	killDaemonByPidFile,
	registerSession,
	type ServeBoot,
} from "@dg/dg-daemon/test-harness";
import { Command } from "commander";
import { localBootstrap } from "../src/commands";
import { mintPageCode } from "../src/start";
import {
	type OverwatchClient,
	registerOverwatchCommands,
} from "../src/overwatch";

const CODE = "one-time-code";

const BOOTSTRAP: SessionBootstrap = {
	port: 43117,
	sessionId: "session-overwatch-open",
	token: "token-overwatch-open",
	agentIdentity: "overwatch-board",
};

class RecordingClient implements OverwatchClient {
	readonly frames: CliRequest[] = [];
	closeCount = 0;

	send(frame: CliRequest): void {
		this.frames.push(frame);
	}

	async request<T>(
		frame: CliRequest,
		accept: (value: unknown) => value is T,
	): Promise<T> {
		this.frames.push(frame);
		const response = { type: "cli-overwatch-open-result" };
		if (!accept(response)) throw new Error("stub response was not accepted");
		return response;
	}

	close(): void {
		this.closeCount += 1;
	}
}

async function runOpen(
	args: string[],
	localBootstrap: () => Promise<SessionBootstrap> = async () => BOOTSTRAP,
	opened: string[] = [],
	launched = true,
	wsl = false,
) {
	const client = new RecordingClient();
	const written: string[] = [];
	const errors: string[] = [];
	const minted: SessionBootstrap[] = [];
	const program = new Command();
	program.exitOverride();
	registerOverwatchCommands(program.command("overwatch"), {
		connect: async () => client,
		write: async (value: string) => {
			written.push(value);
		},
		writeError: async (value: string) => {
			errors.push(value);
		},
		tryOpen: async (url: string) => {
			opened.push(url);
			return launched;
		},
		mintPageCode: async (bootstrap) => {
			minted.push(bootstrap);
			return CODE;
		},
		openFailedHint: () => openFailedHint(wsl),
		localBootstrap,
	});
	await program.parseAsync(["node", "dg-agent", "overwatch", "open", ...args]);
	return { client, opened, written, errors, minted };
}

describe("dg-agent overwatch open", () => {
	it("opens the local /board page with a one-time code by default", async () => {
		const { opened, client, minted } = await runOpen([]);

		expect(opened).toEqual([
			`http://127.0.0.1:${BOOTSTRAP.port}/board#_chatcode=${CODE}`,
		]);
		expect(minted).toEqual([BOOTSTRAP]);
		expect(client.frames).toEqual([]);
	});

	it("sends cli-overwatch-open and does not call tryOpen with --ext", async () => {
		const { opened, client } = await runOpen(["--ext"]);

		expect(client.frames).toEqual([{ type: "cli-overwatch-open" }]);
		expect(opened).toEqual([]);
		expect(client.closeCount).toBe(1);
	});

	it("prints no URL and no token to stdout", async () => {
		const { written, errors } = await runOpen([]);

		expect(written).toEqual([]);
		expect([...written, ...errors].join("")).not.toContain(BOOTSTRAP.token);
	});

	it("writes one stderr line when the browser does not launch", async () => {
		const { errors } = await runOpen([], undefined, [], false);

		expect(errors).toEqual([`${openFailedHint(false)}\n`]);
	});

	it("names the DG_OPEN_WINDOWS opt-in on WSL when the browser does not launch", async () => {
		const { errors } = await runOpen([], undefined, [], false, true);

		expect(errors).toEqual([
			`${openFailedHint(true)}\n`,
		]);
	});

	it("writes nothing to stderr when the browser launches", async () => {
		const { errors } = await runOpen([]);

		expect(errors).toEqual([]);
	});
});

describe("localBootstrap", () => {
	const previousHome = process.env.DG_HOME;
	let home: string | undefined;
	let daemon: ServeBoot | undefined;

	afterEach(() => {
		if (previousHome === undefined) delete process.env.DG_HOME;
		else process.env.DG_HOME = previousHome;
		if (daemon) {
			killDaemonByPidFile(daemon.dgHome);
			rmSync(daemon.dgHome, { recursive: true, force: true });
		}
		if (home) rmSync(home, { recursive: true, force: true });
		home = undefined;
		daemon = undefined;
	});

	function sessionCommand(): Command {
		const program = new Command();
		program.option("-s, --session <id>");
		return program.command("overwatch");
	}

	it("tells the caller to run dg-agent start first when no daemon is live", async () => {
		home = mkdtempSync(join(tmpdir(), "dg-overwatch-open-"));
		process.env.DG_HOME = home;

		const error = await localBootstrap(sessionCommand()).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("Run dg-agent start first");
		expect(message).not.toContain("..");
	});

	it("resolves the registered session and mints a code that exchanges for it", async () => {
		daemon = await bootServe();
		process.env.DG_HOME = daemon.dgHome;
		const registered = await registerSession(daemon.port, {
			agentIdentity: "overwatch-board",
		});

		const bootstrap = await localBootstrap(sessionCommand());

		expect(bootstrap).toEqual({
			port: daemon.port,
			sessionId: registered.sessionId,
			token: registered.token,
			agentIdentity: "overwatch-board",
		});
		const code = await mintPageCode(bootstrap);
		const traded = await fetch(`http://127.0.0.1:${daemon.port}/chat/exchange`, {
			method: "POST",
			headers: {
				Host: `127.0.0.1:${daemon.port}`,
				Origin: `http://127.0.0.1:${daemon.port}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ code }),
		});
		expect(((await traded.json()) as { sessionId: string }).sessionId).toBe(
			registered.sessionId,
		);
	}, 30_000);
});
