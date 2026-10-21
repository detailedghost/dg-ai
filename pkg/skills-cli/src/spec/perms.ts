import { projectHash, stateRoot } from "@dg/common/node";
import { frontmatterOf, nestedScalar, withPermission } from "./frontmatter";
import {
	die,
	flagValue,
	needFile,
	readStdinLine,
	readText,
	replaceText,
	say,
	usageError,
	warn,
} from "./shared";

const PERMISSION_KEY = /^[a-z_]+$/;

const GRANT_ALL_KEYS = [
	"run_commands",
	"git_push",
	"gh_pr_create",
	"auto_cleanup_worktree",
	"slice_commits",
	"housekeeping_commit",
];

async function setPermission(
	spec: string,
	key: string,
	value: string,
): Promise<void> {
	replaceText(spec, withPermission(await readText(spec), key, value));
}

export async function permsCommand(args: string[]): Promise<number> {
	const [spec, action = ""] = args;
	if (spec === undefined)
		return usageError("perms <spec> [--allow|--deny|--show]");
	needFile(spec);
	switch (action) {
		case "--allow":
			await setPermission(spec, "run_commands", "true");
			say("permissions.run_commands: true\n");
			return 0;
		case "--deny":
			await setPermission(spec, "run_commands", "false");
			say("permissions.run_commands: false\n");
			return 0;
		case "--show":
		case "": {
			const current =
				nestedScalar(
					frontmatterOf(await readText(spec)),
					"permissions",
					"run_commands",
				) || "unset";
			say(`permissions.run_commands: ${current}\n`);
			if (action === "--show") return 0;
			process.stderr.write("Grant run_commands permission? [y/N] ");
			const answer = await readStdinLine();
			if (answer === null) return 1;
			const granted = ["y", "Y", "yes", "YES"].includes(answer);
			await setPermission(spec, "run_commands", String(granted));
			say(`set to ${granted}\n`);
			return 0;
		}
		default:
			return die(
				`unknown perms flag: ${action} (expected --allow|--deny|--show)`,
			);
	}
}

const TRUE_VALUES = new Set(["true", "TRUE", "yes", "YES", "1"]);
const FALSE_VALUES = new Set(["false", "FALSE", "no", "NO", "0", ""]);
const BATCH_USAGE =
	"perms-batch <spec> --grant-all|--from-scratch <slug>|--from-file <path>";

export async function permsBatchCommand(args: string[]): Promise<number> {
	if (args.length < 2) return usageError(BATCH_USAGE);
	const [spec = "", ...flags] = args;
	needFile(spec);
	let source = "";
	let grantAll = false;
	for (let i = 0; i < flags.length; ) {
		const flag = flags[i] as string;
		if (flag === "--grant-all") {
			grantAll = true;
			i += 1;
		} else if (flag === "--from-scratch") {
			source = `${stateRoot()}/spec/${projectHash()}/${flagValue(flags, i, flag)}.perms`;
			i += 2;
		} else if (flag === "--from-file") {
			source = flagValue(flags, i, flag);
			i += 2;
		} else die(`unknown perms-batch flag: ${flag}`);
	}

	if (grantAll) {
		let text = await readText(spec);
		for (const key of GRANT_ALL_KEYS) text = withPermission(text, key, "true");
		replaceText(spec, text);
		say(`granted all permissions in ${spec}\n`);
		return 0;
	}
	if (source === "")
		die(
			"perms-batch requires --grant-all, --from-scratch <slug>, or --from-file <path>",
		);
	needFile(source);

	let text = await readText(spec);
	let applied = false;
	const lines = (await readText(source)).split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	for (const raw of lines) {
		const line = raw.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
		if (line === "" || line.startsWith("#")) continue;
		const equals = line.indexOf("=");
		if (equals < 0) {
			warn(`skipping malformed line: ${line}`);
			continue;
		}
		const key = line.slice(0, equals);
		const value = line.slice(equals + 1);
		if (!TRUE_VALUES.has(value) && !FALSE_VALUES.has(value)) {
			warn(`skipping non-boolean value for ${key}: ${value}`);
			continue;
		}
		if (!PERMISSION_KEY.test(key)) {
			warn(`skipping invalid permission key: ${key}`);
			continue;
		}
		text = withPermission(text, key, String(TRUE_VALUES.has(value)));
		applied = true;
	}
	if (applied) replaceText(spec, text);
	say(`applied permissions from ${source}\n`);
	return 0;
}
