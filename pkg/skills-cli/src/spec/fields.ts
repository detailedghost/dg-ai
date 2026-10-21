import { copyFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { isRecord } from "@dg/common";
import { scratchRoot, stateRoot } from "@dg/common/node";
import { type Document, isSeq, parseDocument } from "yaml";
import { frontmatterOf, parseYaml, splitDocument } from "./frontmatter";
import { type FieldSpec, loadSchema, type SchemaFields } from "./schema";
import {
	abspath,
	deny,
	die,
	flagValue,
	jqRaw,
	jqText,
	needFile,
	PROGRAM,
	readText,
	replaceText,
	say,
	stripNewlines,
	truthy,
	usageError,
} from "./shared";

type PathToken = string | number;

const INDEX = /^-?\d+$/;

/** Parse a yq-style path such as `.slices[0].agents.primary`; null when malformed. */
function parseFieldPath(path: string): PathToken[] | null {
	const body = path.startsWith(".") ? path.slice(1) : path;
	const tokens: PathToken[] = [];
	let i = 0;
	while (i < body.length) {
		if (body[i] === ".") {
			i += 1;
			continue;
		}
		if (body[i] === "[") {
			const close = body.indexOf("]", i);
			const index = close < 0 ? "" : body.slice(i + 1, close);
			if (!INDEX.test(index)) return null;
			tokens.push(Number(index));
			i = close + 1;
			continue;
		}
		let end = i;
		while (end < body.length && body[end] !== "." && body[end] !== "[")
			end += 1;
		tokens.push(body.slice(i, end));
		i = end;
	}
	return tokens;
}

function lookup(data: unknown, tokens: PathToken[]): unknown {
	let current = data;
	for (const token of tokens) {
		if (typeof token === "number")
			current = Array.isArray(current) ? current.at(token) : undefined;
		else current = isRecord(current) ? current[token] : undefined;
		if (current === undefined || current === null) return undefined;
	}
	return current;
}

function rootOf(fieldPath: string): string {
	const root = (
		fieldPath.startsWith(".") ? fieldPath.slice(1) : fieldPath
	).replace(/[.[].*$/s, "");
	if (root === "") die(`could not parse root of field-path: ${fieldPath}`);
	return root;
}

function resolveNegativeIndices(
	doc: Document,
	tokens: PathToken[],
): PathToken[] | null {
	const resolved: PathToken[] = [];
	for (const token of tokens) {
		if (typeof token !== "number" || token >= 0) {
			resolved.push(token);
			continue;
		}
		const node = doc.getIn(resolved, true);
		const index = (isSeq(node) ? node.items.length : 0) + token;
		if (index < 0) return null;
		resolved.push(index);
	}
	return resolved;
}

function requireField(
	schema: SchemaFields,
	root: string,
	fieldPath: string,
): FieldSpec {
	const field = schema[root];
	if (field === undefined) deny(`field not in schema: ${fieldPath}`);
	return field;
}

const GET_HELP = `usage: ${PROGRAM} get <spec> <field-path>

Read a frontmatter field from <spec>, where <field-path> is a yq-style
path (e.g. \`feature\`, \`slices[0].agents.primary\`, \`worktree.pr_url\`,
\`permissions.run_commands\`).

Strict mode: the root of <field-path> must be a field in the schema of
the installed spec skill (spec-schema/frontmatter-schema.yaml), even if
the spec happens to contain the field.

Exits:
  0  value printed to stdout
  1  field absent in spec, or root not in schema (stderr explains)
  2  usage or IO error (stderr, prefix "${PROGRAM}:")
`;

const SET_HELP = `usage: ${PROGRAM} set <spec> <field-path> <value>

Write <value> to <field-path> in <spec>'s frontmatter. Field-path is
yq-style (e.g. \`current_slice\`, \`slices[0].agents.primary\`).

Schema enforcement (against frontmatter-schema.yaml):
  - root field must be in schema           -> exit 1 ("field not in schema")
  - immutable field already set            -> exit 1 ("field is immutable...")
  - append-only field                      -> exit 1 ("use append-section...")
  - mutable / mixed / first-time-immutable -> allowed

Value parsing: literal string argument (shell handles quoting). The words
true and false become booleans, whole numbers become integers, everything
else stays a string. The file is replaced atomically.

Exits: 0 ok / 1 schema or mutability denial / 2 usage or IO error.
`;

const VALIDATE_HELP = `usage: ${PROGRAM} validate <spec>

Validate frontmatter of <spec> against the canonical schema shipped in the
installed spec skill (spec-schema/frontmatter-schema.yaml).

Exits:
  0  conformant
  1  validation failed (JSON diagnostics emitted on stdout)
  2  usage or IO error (message on stderr, prefix "${PROGRAM}:")

Checks performed:
  - unknown top-level field (not in schema)
  - wrong type for known field (string/integer/boolean/array/object)
  - mode-conditional field present in wrong mode
    (e.g. \`worktree:\` in a light-mode spec, \`parked_reason:\` outside todo/)

Body content after the closing \`---\` is not checked.
`;

interface PositionalArgs {
	positionals: string[];
	helped: boolean;
}

function readPositionals(
	verb: string,
	args: string[],
	limit: number,
	limitMessage: string,
	help: string,
): PositionalArgs {
	const positionals: string[] = [];
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			say(help);
			return { positionals, helped: true };
		}
		if (arg.startsWith("-")) die(`unknown ${verb} flag: ${arg}`);
		if (positionals.length >= limit) die(limitMessage);
		positionals.push(arg);
	}
	return { positionals, helped: false };
}

export async function getCommand(args: string[]): Promise<number> {
	const { positionals, helped } = readPositionals(
		"get",
		args,
		2,
		"get takes <spec> <field-path>",
		GET_HELP,
	);
	if (helped) return 0;
	const [spec = "", fieldPath = ""] = positionals;
	if (spec === "" || fieldPath === "")
		return usageError("get <spec> <field-path>");
	needFile(spec);
	const schema = await loadSchema();
	requireField(schema, rootOf(fieldPath), fieldPath);
	const tokens = parseFieldPath(fieldPath);
	const front = frontmatterOf(await readText(spec));
	if (front === "") deny("no frontmatter in spec");
	const parsed = parseYaml(front);
	const value = parsed.ok && tokens ? lookup(parsed.value, tokens) : undefined;
	if (value === undefined) deny(`field absent in spec: ${fieldPath}`);
	say(`${stripNewlines(jqRaw(value))}\n`);
	return 0;
}

function coerce(value: string): string | number | boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	return /^-?\d+$/.test(value) ? Number(value) : value;
}

async function setField(
	spec: string,
	fieldPath: string,
	value: string,
): Promise<void> {
	const schema = await loadSchema();
	const field = requireField(schema, rootOf(fieldPath), fieldPath);
	const tokens = parseFieldPath(fieldPath);
	const text = await readText(spec);
	const { front, body } = splitDocument(text);
	if (field.mutability === "append-only")
		deny(
			`field is append-only; use append-section instead of set: ${fieldPath}`,
		);
	if (field.mutability === "immutable") {
		const parsed = parseYaml(front);
		const current =
			parsed.ok && tokens ? lookup(parsed.value, tokens) : undefined;
		if (current !== undefined && stripNewlines(jqRaw(current)) !== "")
			deny(`field is immutable and already set: ${fieldPath}`);
	}
	if (stripNewlines(front) === "") die("no frontmatter in spec");

	const doc = parseDocument(front, { uniqueKeys: false });
	if (doc.errors.length > 0)
		die(`could not set ${fieldPath}: frontmatter is not valid YAML`);
	const target = tokens && resolveNegativeIndices(doc, tokens);
	if (!target)
		die(`could not set ${fieldPath}: path does not fit the frontmatter`);
	try {
		doc.setIn(target, coerce(value));
	} catch {
		die(`could not set ${fieldPath}: path does not fit the frontmatter`);
	}
	replaceText(
		spec,
		`---\n${doc.toString({ lineWidth: 0, flowCollectionPadding: false })}---\n${body}`,
	);
}

export async function setCommand(args: string[]): Promise<number> {
	const { positionals, helped } = readPositionals(
		"set",
		args,
		3,
		"set takes <spec> <field-path> <value>",
		SET_HELP,
	);
	if (helped) return 0;
	const [spec = "", fieldPath = "", value] = positionals;
	if (spec === "" || fieldPath === "" || value === undefined)
		return usageError("set <spec> <field-path> <value>");
	needFile(spec);
	await setField(spec, fieldPath, value);
	say(`${spec}: set ${fieldPath}\n`);
	return 0;
}

export async function prototypeRefCommand(args: string[]): Promise<number> {
	const [bundle, ...flags] = args;
	const syntax = "prototype-ref <bundle> --slice <N> --path <p> --variant <k>";
	if (bundle === undefined) return usageError(syntax);
	const values: Record<string, string> = {};
	for (let i = 0; i < flags.length; ) {
		const flag = flags[i] as string;
		if (flag !== "--slice" && flag !== "--path" && flag !== "--variant")
			die(`unknown prototype-ref flag: ${flag}`);
		values[flag] = flagValue(flags, i, flag);
		i += 2;
	}
	const slice = values["--slice"] ?? "";
	const path = values["--path"] ?? "";
	const variant = values["--variant"] ?? "";
	if (slice === "" || path === "" || variant === "") return usageError(syntax);
	if (!/^\d+$/.test(slice)) die(`slice number must be integer: ${slice}`);
	if (Number(slice) < 1) die(`slice number must be 1 or greater: ${slice}`);
	const plan = `${bundle}/plan.md`;
	needFile(plan);
	needFile(path);
	const index = Number(slice) - 1;
	const parsed = parseYaml(frontmatterOf(await readText(plan)));
	const slices = parsed.ok ? lookup(parsed.value, ["slices"]) : undefined;
	if (!Array.isArray(slices) || index >= slices.length)
		die(`slice ${slice} does not exist in ${plan}`);
	const destRel = `prototype/slice_${slice}_${basename(path)}`;
	mkdirSync(`${bundle}/prototype`, { recursive: true });
	copyFileSync(path, `${bundle}/${destRel}`);
	await setField(plan, `slices[${index}].prototype.path`, destRel);
	await setField(plan, `slices[${index}].prototype.variant`, variant);
	say(`${plan}: recorded prototype for slice ${slice} -> ${destRel}\n`);
	return 0;
}

function jsonType(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number")
		return Number.isInteger(value) ? "integer" : "number";
	return typeof value === "object" ? "object" : typeof value;
}

interface Diagnostic {
	field: string;
	kind: string;
	detail: string;
	path: string;
}

function typeOptions(type: FieldSpec["type"]): string[] {
	return (Array.isArray(type) ? type : [type ?? ""]).map((option) =>
		option === "map" ? "object" : option,
	);
}

function inMode(field: FieldSpec, modes: Record<string, boolean>): boolean {
	return field.mode_conditional === undefined
		? true
		: (modes[field.mode_conditional] ?? true);
}

export async function validateCommand(args: string[]): Promise<number> {
	const { positionals, helped } = readPositionals(
		"validate",
		args,
		1,
		"validate takes a single <spec> argument",
		VALIDATE_HELP,
	);
	if (helped) return 0;
	const [spec] = positionals;
	if (spec === undefined) return usageError("validate <spec>");
	needFile(spec);
	const schema = await loadSchema();
	const specAbs = abspath(spec);
	const front = frontmatterOf(await readText(spec));
	if (front === "") {
		say(
			`${JSON.stringify([{ path: specAbs, error: "no frontmatter block" }])}\n`,
		);
		return 1;
	}
	const parsed = parseYaml(front);
	if (!parsed.ok) {
		say(
			`${JSON.stringify([{ path: specAbs, error: "frontmatter is not valid YAML" }])}\n`,
		);
		return 1;
	}
	const data = isRecord(parsed.value) ? parsed.value : {};

	const scratch = scratchRoot();
	const modes = {
		"parked-only":
			specAbs.includes("/.agents/todo/") ||
			specAbs.includes("/.agents/spec/todo/") ||
			specAbs.startsWith(`${scratch}/todo/`),
		"light-only": specAbs.startsWith(`${stateRoot()}/spec/`),
		"worktree-only": truthy(data.worktree),
		"cross-repo-only": truthy(data.repos) || data.pr_strategy === "cross-repo",
	};

	const diagnostics: Diagnostic[] = [];
	const report = (field: string, kind: string, detail: string) =>
		diagnostics.push({ field, kind, detail, path: specAbs });
	for (const key of Object.keys(data))
		if (!Object.hasOwn(schema, key))
			report(key, "unknown_field", "not in schema");
	for (const [key, field] of Object.entries(schema)) {
		const value = data[key];
		if (value === undefined || value === null) continue;
		const actual = jsonType(value);
		if (!typeOptions(field.type).includes(actual))
			report(
				key,
				"wrong_type",
				`expected ${jqText(field.type)}, got ${actual}`,
			);
		if (!inMode(field, modes))
			report(
				key,
				"mode_violation",
				`field is ${field.mode_conditional} but spec is not in that mode`,
			);
		if (
			truthy(field.enum) &&
			typeof value === "string" &&
			!(field.enum as unknown[]).includes(value)
		)
			report(
				key,
				"enum_violation",
				`value "${value}" not in ${jqText(field.enum)}`,
			);
	}
	if (diagnostics.length === 0) {
		say(`${specAbs}: ok\n`);
		return 0;
	}
	say(`${JSON.stringify(diagnostics, null, 2)}\n`);
	return 1;
}
