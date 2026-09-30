import {
	CHAT_SERVICES_PATH,
	DgCliError,
	EXIT_GENERAL_FAILURE,
} from "@dg/common";
import {
	isDaemonLive,
	loopbackHostHeader,
	readPidFile,
	resolveDgPaths,
} from "@dg/common/node";
import type { Command } from "commander";
import type { ServiceStatus } from "../services/supervisor";

async function callDaemon(
	path: string,
	method: "GET" | "POST",
): Promise<unknown> {
	const handle = readPidFile(resolveDgPaths());
	if (!handle || !(await isDaemonLive(handle))) {
		throw new DgCliError(
			"no live dg-daemon — services run inside it, so start it first",
			EXIT_GENERAL_FAILURE,
		);
	}
	const resp = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
		method,
		headers: loopbackHostHeader(handle.port),
	});
	if (!resp.ok)
		throw new DgCliError((await resp.text()).trim(), EXIT_GENERAL_FAILURE);
	return resp.json();
}

function formatStatus(service: ServiceStatus): string {
	const parts = [
		service.label,
		service.state,
		service.pid === null ? "" : `pid ${service.pid}`,
		`restarts ${service.restarts}`,
		service.lastExit ? `last ${service.lastExit}` : "",
		`log ${service.logFile}`,
		service.error ?? "",
	];
	return parts.filter((part) => part.length > 0).join("  ");
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
		);

	service
		.command("status")
		.description("show every declared service, or one by label")
		.argument("[label]")
		.action(async (label: string | undefined) => {
			const { services } = (await callDaemon(CHAT_SERVICES_PATH, "GET")) as {
				services: ServiceStatus[];
			};
			const shown = services.filter((entry) => !label || entry.label === label);
			if (shown.length === 0) {
				throw new DgCliError(
					label ? `no service labelled "${label}"` : "no services declared",
					EXIT_GENERAL_FAILURE,
				);
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
				)) as ServiceStatus;
				console.log(formatStatus(status));
			});
	}
}
