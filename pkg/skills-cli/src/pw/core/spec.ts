import type { BrowserContext, Page, Route } from "playwright-core";
import type { Events } from "./events";

export type FlagSpec = {
	name: string;
	type: "string" | "boolean";
	help: string;
	multiple?: boolean;
};

export type CommandGroup =
	| "core"
	| "navigation"
	| "keyboard"
	| "mouse"
	| "tabs"
	| "storage"
	| "network"
	| "devtools"
	| "session"
	| "state";

export type CommandSpec = {
	name: string;
	group: CommandGroup;
	side: "client" | "daemon";
	positionals: { name: string; required: boolean; variadic?: boolean }[];
	flags: FlagSpec[];
	help: string;
	changesPage: boolean;
};

export type ParsedArgs = {
	session: string;
	command: string;
	positionals: string[];
	flags: Record<string, string | boolean>;
	raw: boolean;
	codegen: boolean;
};

export type RouteEntry = {
	pattern: string;
	status?: number;
	body?: string;
	contentType?: string;
	addHeaders?: Record<string, string>;
	removeHeaders?: string[];
	handler: (route: Route) => Promise<void>;
};

export type DaemonState = {
	routes: RouteEntry[];
	tracing: boolean;
	video?: { page: Page; file: string };
};

export type Ctx = {
	context: BrowserContext;
	page(): Page;
	selectTab(index: number): void;
	outputDir: string;
	clientCwd: string;
	events: Events;
	state: DaemonState;
};

export type SnapshotRequest = {
	target?: string;
	depth?: number;
	filename?: string;
};

export type HandlerResult = {
	result?: unknown;
	code?: string;
	error?: string;
	snapshot?: true | SnapshotRequest;
};

export type DaemonHandler = (ctx: Ctx, args: ParsedArgs) => Promise<HandlerResult>;

export type ClientEnv = {
	cwd: string;
	out(text: string): void;
	err(text: string): void;
};

export type ClientHandler = (args: ParsedArgs, env: ClientEnv) => Promise<number>;

export type Loader = () => Promise<{ default: DaemonHandler | ClientHandler }>;

export const defineCommand = (spec: CommandSpec): CommandSpec => spec;
