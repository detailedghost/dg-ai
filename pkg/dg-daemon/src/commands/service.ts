import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	CHAT_SERVICES_PATH,
	DgCliError,
	EXIT_GENERAL_FAILURE,
	parseEvery,
} from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import type { Command } from "commander";
import { parseJobEntry } from "../jobs/config";
import { readConfigStrict, writeJobEntry } from "../server/config-store";
import type { ServiceStatus } from "../services/supervisor";
import {
	assertDaemonAnswers,
	assertNoLiveInstance,
	callDaemon,
	ensureMigrated,
	findLiveDaemon,
	formatStatus,
	guardConfig,
	isDeclared,
	isInTable,
	requireMigrated,
	resolveExecutable,
	withConfigLock,
} from "./job-support";

const RENAME_NOTE =
	'note: "dg service" is now "dg job"; this form goes away in the next major release';

function nextStepLine(
	live: boolean,
	autostart: boolean,
	label: string,
): string {
	if (live) return `next: dg service start ${label}`;
	if (autostart) return "next: dg daemon start";
	return `next: dg daemon start, then dg service start ${label}`;
}

const servicePath = (label: string, verb?: "start" | "stop") =>
	[CHAT_SERVICES_PATH, encodeURIComponent(label), verb]
		.filter((segment) => segment !== undefined)
		.join("/");

export function registerServiceCommands(program: Command): void {
	const service = program
		.command("service")
		.description(
			"run the long-lived scripts declared under `services` in the daemon config",
		)
		.hook("preAction", () => {
			console.error(RENAME_NOTE);
		});

	service
		.command("add")
		.description("declare a service in the daemon config")
		.argument("<label>")
		.argument("[command...]", "the command to run, after a bare --")
		.requiredOption("--cwd <path>", "working directory for the service")
		.option("--autostart", "start it when the daemon starts")
		.option("--env-file <path>", "env file to load")
		.option(
			"--pass-env <NAME>",
			"environment variable to pass through (repeatable)",
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.option("--stop-timeout <duration>", "grace period on stop, e.g. 30s")
		.option("--grant <prefix>", "credential grant prefix")
		.action(
			async (
				label: string,
				argv: string[],
				options: {
					cwd: string;
					autostart?: boolean;
					envFile?: string;
					passEnv?: string[];
					stopTimeout?: string;
					grant?: string;
				},
			) => {
				const fail = (message: string): never => {
					throw new DgCliError(message, EXIT_GENERAL_FAILURE);
				};
				if (argv.length === 0) {
					fail("service add: no command given — put it after a bare --");
				}
				const paths = resolveDgPaths();
				const cwd = resolve(options.cwd);
				if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
					fail(`--cwd: no such directory: ${options.cwd}`);
				}
				const stopTimeoutMs =
					options.stopTimeout === undefined
						? undefined
						: parseEvery(options.stopTimeout, "--stop-timeout");
				const [command, ...rest] = argv;
				const executable = resolveExecutable(command, "service add:");
				const entry = {
					argv: [executable, ...rest],
					cwd,
					continuous: true,
					...(options.autostart ? { enabled: true } : {}),
					...(options.envFile === undefined
						? {}
						: { envFile: resolve(options.envFile) }),
					...(options.passEnv === undefined
						? {}
						: { passEnv: options.passEnv }),
					...(stopTimeoutMs === undefined ? {} : { stopTimeoutMs }),
					...(options.grant === undefined ? {} : { grant: options.grant }),
				};
				const parsed = parseJobEntry(label, entry);
				if (!parsed.ok) fail(`service add: ${parsed.error}`);
				await ensureMigrated(paths);
				await withConfigLock(paths, () => {
					const config = guardConfig(() => readConfigStrict(paths));
					requireMigrated(config);
					if (isInTable(config, label)) {
						fail(`a service labelled "${label}" already exists`);
					}
					guardConfig(() => writeJobEntry(paths, label, entry));
				});
				console.log(`added service "${label}"`);
				console.log(
					nextStepLine(
						Boolean(await findLiveDaemon(paths)),
						Boolean(options.autostart),
						label,
					),
				);
			},
		);

	service
		.command("rm")
		.description("remove a service declaration")
		.argument("<label>")
		.action(async (label: string) => {
			const paths = resolveDgPaths();
			const requireDeclared = () => {
				const config = guardConfig(() => readConfigStrict(paths));
				requireMigrated(config);
				if (!isDeclared(config, label)) {
					throw new DgCliError(
						`no service labelled "${label}"`,
						EXIT_GENERAL_FAILURE,
					);
				}
			};
			if (!existsSync(paths.daemonConfigPath)) {
				throw new DgCliError(
					`no service labelled "${label}"`,
					EXIT_GENERAL_FAILURE,
				);
			}
			await ensureMigrated(paths);
			requireDeclared();
			const live = await assertDaemonAnswers(paths, label);
			if (live) {
				const { services } = (await callDaemon(CHAT_SERVICES_PATH, "GET", "service")) as {
					services: ServiceStatus[];
				};
				const state = services.find((entry) => entry.label === label)?.state;
				if (state === "running" || state === "backoff") {
					throw new DgCliError(
						`service "${label}" is ${state} — stop it first with dg service stop ${label}`,
						EXIT_GENERAL_FAILURE,
					);
				}
			}
			await withConfigLock(paths, () => {
				requireDeclared();
				assertNoLiveInstance(paths, label);
				guardConfig(() => writeJobEntry(paths, label, undefined));
			});
			console.log(`removed service "${label}"`);
		});

	service
		.command("status")
		.description("show every declared service, or one by label")
		.argument("[label]")
		.option("--json", "print one JSON line")
		.action(async (label: string | undefined, options: { json?: boolean }) => {
			const { services } = (await callDaemon(CHAT_SERVICES_PATH, "GET", "service")) as {
				services: ServiceStatus[];
			};
			const shown = services.filter((entry) => !label || entry.label === label);
			if (label && shown.length === 0) {
				throw new DgCliError(
					`no service labelled "${label}"`,
					EXIT_GENERAL_FAILURE,
				);
			}
			if (options.json) {
				console.log(JSON.stringify({ services: shown }));
				return;
			}
			if (shown.length === 0) {
				throw new DgCliError("no services declared", EXIT_GENERAL_FAILURE);
			}
			for (const entry of shown) console.log(formatStatus(entry));
		});

	for (const verb of ["start", "stop"] as const) {
		service
			.command(verb)
			.description(`${verb} a declared service`)
			.argument("<label>")
			.action(async (label: string) => {
				const status = (await callDaemon(
					servicePath(label, verb),
					"POST",
					"service",
				)) as ServiceStatus;
				console.log(formatStatus(status));
			});
	}
}
