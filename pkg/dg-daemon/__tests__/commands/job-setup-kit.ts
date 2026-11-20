import { expect } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CHAT_JOBS_PATH,
	type CredentialMeta,
	DgCliError,
} from "@dg/common";
import type {
	JobCredentialClient,
	JobCredentialStatus,
} from "@dg/common/node";
import type { JobSetupDeps } from "../../src/commands/job-setup";
import type { RunSource } from "../../src/jobs/secret-sources";
import { freshTempDir } from "../utils/daemon-harness";
import {
	SLEEPER_ARGV,
	startFakeDaemon,
	type FakeDaemon,
} from "./job-cli-helpers";
import {
	type RunOutcome,
	runJob,
	type Sandbox,
	sandbox,
} from "./job-source-kit";

export const VALUE_A = "tok-alpha-91f3c2d8";
export const VALUE_B = "tok-bravo-77d0e4a1";
export const VALUE_C = "tok-charlie-5b2e9f60";
export const ALL_VALUES = [VALUE_A, VALUE_B, VALUE_C];
export const SHA = "a".repeat(40);

export const noValue = (text: string): void => {
	for (const value of ALL_VALUES) expect(text).not.toContain(value);
};

export const gitRecord = (
	jobs: string[],
	credentials: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) => ({
	x: {
		kind: "git",
		url: "file:///tmp/x",
		ref: null,
		sha: SHA,
		jobs,
		declarationHash: "f".repeat(64),
		credentials,
		...extra,
	},
});

export type Stored = { name: string; meta?: CredentialMeta; updatedAt?: string };

export type ClientOptions = {
	grant?: JobCredentialStatus["grant"];
	stored?: Stored[];
	failSet?: string;
	failGrant?: boolean;
	failRotate?: string;
};

export function fakeClient(options: ClientOptions = {}) {
	const credentials = [...(options.stored ?? [])];
	let grant = options.grant ?? "missing";
	const calls = {
		set: [] as { name: string; value: string; meta: CredentialMeta | undefined }[],
		ensureGrant: 0,
		rotateGrant: 0,
	};
	const client = (job: string): JobCredentialClient => ({
		status: async () => ({
			prefix: job,
			grant,
			credentials: credentials.map((entry) => ({
				name: entry.name,
				meta: entry.meta ?? {},
				updatedAt: entry.updatedAt ?? "2026-01-02T03:04:05.000Z",
			})),
		}),
		set: async (name, value, meta) => {
			if (options.failSet === name) throw new DgCliError("the route refused it", 1);
			calls.set.push({ name, value, meta });
			const at = credentials.findIndex((entry) => entry.name === name);
			if (at >= 0) credentials.splice(at, 1);
			credentials.push({ name, meta });
		},
		delete: async () => true,
		ensureGrant: async () => {
			calls.ensureGrant++;
			if (options.failGrant) throw new DgCliError("the token was refused", 1);
			grant = "ok";
			return { created: true, path: "/token" };
		},
		rotateGrant: async () => {
			calls.rotateGrant++;
			if (options.failRotate) throw new DgCliError(options.failRotate, 1);
			return { path: "/token" };
		},
	});
	return { calls, client };
}

export type Asked = {
	hidden: string[];
	lines: string[];
	confirms: string[];
	sources: { argv: string[]; env: Record<string, string | undefined> }[];
};

export type RigOptions = ClientOptions & {
	terminal?: boolean;
	hidden?: string[];
	lines?: string[];
	answer?: (question: string) => boolean;
	source?: (argv: string[]) => { code: number; stdout: string; stderr: string };
	running?: string[];
	rows?: Record<string, Record<string, unknown>>;
};

export function setupRig(
	jobs: (cwd: string) => Record<string, unknown>,
	options: RigOptions = {},
) {
	const box = sandbox(["tool", "sh", "aws"]);
	const cwd = freshTempDir("job-cwd");
	const sb: Sandbox = box.create(jobs(cwd));
	const states = new Map<string, string>(
		Object.keys(jobs(cwd)).map((name) => [name, "stopped"]),
	);
	for (const name of options.running ?? []) states.set(name, "running");
	const row = (label: string) => ({
		label,
		state: states.get(label) ?? "stopped",
		pid: states.get(label) === "running" ? 4242 : null,
		restarts: 0,
		logFile: "/log",
		...(options.rows?.[label] ?? {}),
	});
	const daemon: FakeDaemon = startFakeDaemon(sb.dgHome, (method, path) => {
		if (method === "GET" && path === CHAT_JOBS_PATH) {
			return Response.json({
				instanceId: "i",
				jobs: [...states.keys()].map(row),
			});
		}
		const start = /\/jobs\/([^/]+)\/start$/.exec(path);
		if (method === "POST" && start) {
			states.set(start[1], "running");
			return Response.json(row(start[1]));
		}
		return new Response("not found", { status: 404 });
	});
	const fake = fakeClient(options);
	const clientPaths: string[] = [];
	const asked: Asked = { hidden: [], lines: [], confirms: [], sources: [] };
	const hidden = [...(options.hidden ?? [])];
	const lines = [...(options.lines ?? [])];
	const runSource: RunSource = async (argv, { env }) => {
		asked.sources.push({ argv, env });
		if (!options.source) throw new Error("unexpected runSource");
		return options.source(argv);
	};
	const setup: Partial<JobSetupDeps> = {
		isTerminal: () => options.terminal ?? true,
		confirm: async (question) => {
			asked.confirms.push(question);
			if (/Start dg at login/.test(question)) return false;
			return (options.answer ?? (() => true))(question);
		},
		readHidden: async (prompt) => {
			asked.hidden.push(prompt);
			const next = hidden.shift();
			if (next === undefined) throw new Error(`unexpected readHidden: ${prompt}`);
			return next;
		},
		readLine: async (prompt) => {
			asked.lines.push(prompt);
			return lines.shift() ?? "";
		},
		runSource,
		client: (paths, job) => {
			clientPaths.push(paths.daemonConfigPath);
			return fake.client(job);
		},
	};
	return {
		sb,
		daemon,
		asked,
		calls: fake.calls,
		clientPaths,
		states,
		run(args: string[], over: Partial<JobSetupDeps> = {}): Promise<RunOutcome> {
			return runJob(args, { ...sb.deps(), ...setup, ...over });
		},
		table(): Record<string, Record<string, unknown>> {
			return JSON.parse(readFileSync(sb.paths.daemonConfigPath, "utf8")).jobs;
		},
		config(): Record<string, unknown> {
			return JSON.parse(readFileSync(sb.paths.daemonConfigPath, "utf8"));
		},
		registry(): Record<string, Record<string, unknown>> {
			try {
				return JSON.parse(readFileSync(sb.paths.jobSourcesPath, "utf8"));
			} catch {
				return {};
			}
		},
		seedRegistry(registry: unknown): void {
			mkdirSync(dirname(sb.paths.jobSourcesPath), { recursive: true });
			writeFileSync(sb.paths.jobSourcesPath, JSON.stringify(registry), { mode: 0o600 });
		},
		close(): void {
			daemon.stop();
			box.cleanup();
		},
	};
}

export type Rig = ReturnType<typeof setupRig>;

export const credentialJob = (
	cwd: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	continuous: true,
	argv: SLEEPER_ARGV,
	cwd,
	credentials: ["api", "metrics", "errors"],
	grant: "x",
	...extra,
});

export function setupFile(
	answers: unknown,
	mode = 0o600,
): string {
	const file = join(freshTempDir("job-setup-file"), "answers.json");
	writeFileSync(file, typeof answers === "string" ? answers : JSON.stringify(answers), {
		mode,
	});
	chmodSync(file, mode);
	return file;
}

export const streamOf = (text: string): (() => ReadableStream<Uint8Array>) => () =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});

export const everything = (outcome: RunOutcome): string =>
	`${outcome.stdout}\n${outcome.stderr}`;
