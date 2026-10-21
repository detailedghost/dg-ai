import {
	briefCommand,
	contextCommand,
	diffBundleCommand,
	readyCommand,
} from "./context";
import {
	getCommand,
	prototypeRefCommand,
	setCommand,
	validateCommand,
} from "./fields";
import { lintWavesCommand } from "./lint-waves";
import { nextNnnCommand, resolvePathCommand, slugifyCommand } from "./paths";
import { permsBatchCommand, permsCommand } from "./perms";
import { rosterCommand } from "./roster";
import { reviewCommand, roundtableCommand } from "./roundtable";
import { scaffoldCommand } from "./scaffold";
import {
	appendSectionCommand,
	auditCommand,
	issuesCommand,
	prBodyCommand,
	sliceCommand,
} from "./sections";
import { type Handler, PROGRAM, SpecError } from "./shared";

const USAGE = `usage: ${PROGRAM} <subcommand> [args]

Helper for /spec orchestration.

Subcommands:
  perms          toggle/show permissions.run_commands in spec frontmatter
  perms-batch    apply a batch of permissions (--grant-all, --from-scratch, --from-file)
  next-nnn       print the next NNN by scanning .agents/create-specs/ (--from-repo, --home)
  roundtable     parallel agent review via \`claude -p\`
  review         alias: roundtable --phase 5 --append
  slice          extract one slice's Engineering/Testing/Acceptance blocks
  context        emit spec + school files + paths as one context pack (bundle: write context.md)
  brief          short rehydrator for post-/compact phases
  diff-bundle    per-slice changed-file list vs git merge-base
  audit          unchecked-box report grouped by section
  ready          exit 0 iff slice dependencies are committed
  pr-body        PR Summary + Test Plan + Issues Remediation markdown
  issues         add|list|resolve entries in Issues Remediation
  slugify        normalize a string into feature_snake_case
  resolve-path   resolve the spec path from mode flags and a slug
  validate       check spec frontmatter against the spec schema
  get            read a schema-checked frontmatter field
  set            write a schema-checked frontmatter field
  append-section append a line under a body section
  roster         list Codex/Claude agents as name<TAB>description (--full adds prose)
  scaffold       expand a decision blob into a plan bundle
  lint-waves     fail when same-layer slices share files (plan.md or blob.json)
  prototype-ref  record an accepted prototype asset on a slice
`;

const HANDLERS = new Map<string, Handler>([
	["perms", permsCommand],
	["perms-batch", permsBatchCommand],
	["next-nnn", nextNnnCommand],
	["roundtable", roundtableCommand],
	["review", reviewCommand],
	["slice", sliceCommand],
	["context", contextCommand],
	["brief", briefCommand],
	["diff-bundle", diffBundleCommand],
	["audit", auditCommand],
	["ready", readyCommand],
	["pr-body", prBodyCommand],
	["issues", issuesCommand],
	["slugify", slugifyCommand],
	["resolve-path", resolvePathCommand],
	["validate", validateCommand],
	["get", getCommand],
	["set", setCommand],
	["append-section", appendSectionCommand],
	["roster", rosterCommand],
	["scaffold", scaffoldCommand],
	["lint-waves", lintWavesCommand],
	["prototype-ref", prototypeRefCommand],
]);

function fail(message: string, status: number): number {
	process.stderr.write(`${PROGRAM}: ${message}\n`);
	return status;
}

export async function main(argv: string[]): Promise<number> {
	const [verb, ...rest] = argv;
	if (verb === undefined) {
		process.stdout.write(USAGE);
		return 2;
	}
	if (verb === "-h" || verb === "--help" || verb === "help") {
		process.stdout.write(USAGE);
		return 0;
	}
	const handler = HANDLERS.get(verb);
	if (handler === undefined)
		return fail(`unknown subcommand: ${verb} (try --help)`, 2);
	try {
		return await handler(rest);
	} catch (error) {
		if (error instanceof SpecError) return fail(error.message, error.status);
		return fail(error instanceof Error ? error.message : String(error), 1);
	}
}
