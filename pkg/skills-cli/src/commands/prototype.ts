import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tryOpen } from "@dg/common/node";
import type { Command } from "commander";
import {
	changesPath,
	decisionPath,
	prototypeDir,
	reloadPath,
	selectionPath,
} from "../prototype/paths";
import { startPrototypeServer } from "../prototype/serve";
import {
	type DecisionResult,
	type SelectionResult,
	confirmSelection,
	selectionStatus,
	waitForDecision,
	waitForSelection,
} from "../prototype/sentinel";
import { NoUiSessionError, UI_DEFAULTS, runUi, statusUi, waitUi } from "../prototype/ui";
import { resolveSkillAsset } from "../utils/skill-assets";

const DEFAULT_WAIT_TIMEOUT_SEC = 900;

function timeoutSeconds(value: string): number {
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new TypeError("--timeout must be a positive number of seconds");
	}
	return seconds;
}

function portNumber(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new TypeError(`Invalid port: ${value}`);
	}
	return port;
}

function printSelectionResult(result: SelectionResult, json: boolean): void {
	if (json) {
		console.log(JSON.stringify(result));
	} else if (result.status === "ok") {
		console.log(result.variant);
		if (result.notes) console.log(result.notes);
	} else if (result.status === "rejected") {
		console.log("rejected");
		if (result.notes) console.log(result.notes);
	} else {
		console.log("timeout");
	}
	process.exitCode = result.status === "timeout" ? 1 : 0;
}

function printDecisionResult(result: DecisionResult, json: boolean): void {
	if (result.status === "timeout") {
		console.log(json ? '{"status":"timeout"}' : "timeout");
		process.exitCode = 1;
		return;
	}
	console.log(json ? result.raw : result.decision);
	process.exitCode = 0;
}

/** Register the `prototype` command group: local terminal/UI-variant/walkthrough prototyping. */
export function registerPrototype(program: Command): void {
	const prototype = program
		.command("prototype")
		.description("prototype locally: a terminal app, UI variants on one route, or a plan walkthrough")
		.addHelpText(
			"after",
			"\nRun selection/decision subcommands from the target project root so durable prototypes resolve into that project's .agents/prototype directory.\n",
		);

	prototype
		.command("dir")
		.description("print the prototype's bare working directory (no sentinel suffix)")
		.argument("<name>", "prototype name")
		.option("--light", "use the --light scratch sandbox")
		.action(async (name: string, opts: { light?: boolean }) => {
			console.log(await prototypeDir(name, { light: opts.light }));
		});

	const selection = prototype
		.command("selection")
		.description("UI-variant decision sentinel (confirm/reject written by the browser)");

	selection
		.command("wait")
		.description("block until a variant is confirmed or rejected")
		.argument("<name>", "prototype name")
		.option("--timeout <sec>", "timeout in seconds", String(DEFAULT_WAIT_TIMEOUT_SEC))
		.option("--light", "use the --light scratch sandbox")
		.option("--json", "print one JSON line instead of plain text")
		.action(async (name: string, opts: { timeout: string; light?: boolean; json?: boolean }) => {
			const result = await waitForSelection(name, {
				light: opts.light,
				timeoutMs: timeoutSeconds(opts.timeout) * 1000,
			});
			printSelectionResult(result, !!opts.json);
		});

	selection
		.command("confirm")
		.description("write a selection sentinel (manual confirmation, no browser round-trip)")
		.argument("<name>", "prototype name")
		.argument("<variant>", "selected variant key")
		.option("--light", "use the --light scratch sandbox")
		.option("--notes <text>", "optional notes to record alongside the selection")
		.action(async (name: string, variant: string, opts: { light?: boolean; notes?: string }) => {
			await confirmSelection(name, variant, { light: opts.light, notes: opts.notes });
		});

	selection
		.command("status")
		.description('non-consuming read: a variant key, "rejected", or "pending"')
		.argument("<name>", "prototype name")
		.option("--light", "use the --light scratch sandbox")
		.action(async (name: string, opts: { light?: boolean }) => {
			console.log(await selectionStatus(name, { light: opts.light }));
		});

	selection
		.command("path")
		.description("print the selection sentinel path")
		.argument("<name>", "prototype name")
		.option("--light", "use the --light scratch sandbox")
		.action(async (name: string, opts: { light?: boolean }) => {
			console.log(await selectionPath(name, { light: opts.light }));
		});

	const decision = prototype
		.command("decision")
		.description("plan-walkthrough decision sentinel (approve/rework written by the browser)");

	decision
		.command("wait")
		.description("block until a plan-walkthrough decision is written")
		.argument("<name>", "prototype name")
		.option("--timeout <sec>", "timeout in seconds", String(DEFAULT_WAIT_TIMEOUT_SEC))
		.option("--light", "use the --light scratch sandbox")
		.option("--json", "print the raw decision JSON instead of just the decision value")
		.action(async (name: string, opts: { timeout: string; light?: boolean; json?: boolean }) => {
			const result = await waitForDecision(name, {
				light: opts.light,
				timeoutMs: timeoutSeconds(opts.timeout) * 1000,
			});
			printDecisionResult(result, !!opts.json);
		});

	decision
		.command("path")
		.description("print the decision sentinel path")
		.argument("<name>", "prototype name")
		.option("--light", "use the --light scratch sandbox")
		.action(async (name: string, opts: { light?: boolean }) => {
			console.log(await decisionPath(name, { light: opts.light }));
		});

	decision
		.command("reload-path")
		.description("print the live-reload token path")
		.argument("<name>", "prototype name")
		.option("--light", "use the --light scratch sandbox")
		.action(async (name: string, opts: { light?: boolean }) => {
			console.log(await reloadPath(name, { light: opts.light }));
		});

	decision
		.command("changes-path")
		.description('print the "what changed" sidecar path')
		.argument("<name>", "prototype name")
		.option("--light", "use the --light scratch sandbox")
		.action(async (name: string, opts: { light?: boolean }) => {
			console.log(await changesPath(name, { light: opts.light }));
		});

	prototype
		.command("components")
		.description("print the installed prototype-components directory")
		.action(() => {
			console.log(resolveSkillAsset("proto", "references/templates"));
		});

	prototype
		.command("open")
		.description("open a prototype URL or file in the default browser (WSL-aware)")
		.argument("<target>", "an http(s) URL, or a local file path")
		.action(async (target: string) => {
			const isUrl = /^https?:\/\//.test(target);
			const absolute = resolve(target);
			const url = isUrl ? target : existsSync(absolute) ? pathToFileURL(absolute).toString() : target;
			const ok = await tryOpen(url);
			if (!ok) {
				console.error(`prototype open: no browser opener found; visit: ${url}`);
				process.exitCode = 1;
			}
		});

	prototype
		.command("serve")
		.description("serve a self-contained prototype HTML file and wire its decision bar")
		.argument("<html-file>", "path to the self-contained HTML file")
		.argument("<name>", "prototype name")
		.option("--light", "use the --light scratch sandbox")
		.option("--port <port>", "preferred port (auto-increments if taken)", "4321")
		.action(async (htmlFile: string, name: string, opts: { light?: boolean; port: string }) => {
			const server = await startPrototypeServer(htmlFile, name, {
				light: opts.light,
				cwd: process.cwd(),
				port: portNumber(opts.port),
			});
			console.log(`prototype-serve: http://127.0.0.1:${server.port}/`);
			console.log(`  html  : ${htmlFile}`);
			console.log(`  name  : ${name}${opts.light ? " (--light)" : ""}`);
			console.log("  Press Ctrl-C to stop.");
		});

	const ui = prototype
		.command("ui")
		.description("render a manifest's variants, serve, open, and block for a decision")
		.argument("[manifest]", "manifest file, or - for stdin")
		.option("--light", "use the --light scratch sandbox")
		.option("--port <port>", "preferred port", String(UI_DEFAULTS.port))
		.option("--timeout <sec>", "timeout in seconds", String(UI_DEFAULTS.timeoutSec))
		.option("--no-open", "do not auto-open the browser")
		.action(
			async (
				manifest: string | undefined,
				opts: { light?: boolean; port: string; timeout: string; open: boolean },
			) => {
				if (!manifest) throw new TypeError("prototype ui requires a manifest file, or - for stdin");
				const result = await runUi(manifest, {
					light: !!opts.light,
					port: portNumber(opts.port),
					timeoutSec: timeoutSeconds(opts.timeout),
					noOpen: !opts.open,
				});
				printSelectionResult(result, true);
			},
		);

	ui.command("wait")
		.description("block for a decision in an existing ui session")
		.argument("<name>", "prototype name")
		.option("--timeout <sec>", "timeout in seconds", String(UI_DEFAULTS.timeoutSec))
		.action(async (name: string, opts: { timeout: string }) => {
			try {
				const result = await waitUi(name, timeoutSeconds(opts.timeout));
				printSelectionResult(result, true);
			} catch (error) {
				if (error instanceof NoUiSessionError) {
					console.error(`prototype ui: ${error.message}`);
					process.exit(2);
				}
				throw error;
			}
		});

	ui.command("status")
		.description("non-consuming read of an existing ui session")
		.argument("<name>", "prototype name")
		.action(async (name: string) => {
			try {
				console.log(await statusUi(name));
			} catch (error) {
				if (error instanceof NoUiSessionError) {
					console.error(`prototype ui: ${error.message}`);
					process.exit(2);
				}
				throw error;
			}
		});
}
