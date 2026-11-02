import path from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { commandName, normalize, optionArgs } from "./args";

export const PROTECTED_SESSIONS: readonly string[] = ["inbox-proton"];

const ALLOWED_COMMANDS = new Set(["close", "delete-data", "tab-list"]);

/** Whether a session holds a signed-in mailbox and runs with restricted output. */
export const isProtectedSession = (name: string): boolean =>
	PROTECTED_SESSIONS.includes(name);

function profileFlag(options: readonly string[]): string | undefined {
	let value: string | undefined;
	options.forEach((arg, index) => {
		if (arg.startsWith("--profile=")) value = arg.slice("--profile=".length);
		else if (arg === "--profile") value = options[index + 1];
	});
	return value;
}

function isProtectedProfile(profile: string): boolean {
	const windowsStyle = /^[a-z]:|\\/i.test(profile);
	const slashed = (
		windowsStyle ? path.win32.normalize(profile) : path.posix.normalize(profile)
	)
		.replaceAll("\\", "/")
		.toLowerCase()
		.replace(/\/+$/, "");
	if (
		PROTECTED_SESSIONS.some((name) =>
			slashed.endsWith(`/playwright-cli/profiles/${name}`),
		)
	)
		return true;
	const local = path.resolve(process.cwd(), profile);
	const proton = path.join(
		resolveDgPaths().stateDir,
		"inbox",
		"proton-profile",
	);
	return path.relative(proton, local) === "";
}

/** Refuses public pw and pw-code access to a signed-in mailbox session or its profile, except closing or clearing it. */
export function protectedSessionRefusal(
	argv: readonly string[],
	program: "pw" | "pw-code" = "pw",
): string | undefined {
	let args: string[];
	try {
		args = normalize(argv);
	} catch {
		return undefined;
	}
	const options = optionArgs(args);
	const profile = profileFlag(options);
	if (profile !== undefined && isProtectedProfile(profile))
		return `${program} refuses the inbox-proton profile: it holds a signed-in mailbox. Use dg-skills inbox.`;
	const session =
		options
			.findLast((arg) => arg.startsWith("--session="))
			?.slice("--session=".length) ?? process.env["PLAYWRIGHT_CLI_SESSION"];
	if (!session || !isProtectedSession(session)) return undefined;
	const name = program === "pw-code" ? program : commandName(args);
	if (name !== undefined && program === "pw" && ALLOWED_COMMANDS.has(name))
		return undefined;
	return `${program} refuses ${name ?? "this command"} on the ${session} session: it holds a signed-in mailbox. Use dg-skills inbox, or close it with pw -s=${session} close.`;
}
