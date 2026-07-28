import { createHash } from "node:crypto";
import {
	readdir,
	readFile,
	realpath,
	lstat,
	stat,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

export const MAILBOX_CONTRACT_MANIFEST =
	"pkg/extension/mailbox-provider-v1.json";

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_EXTENSIONS = new Set([
	".cjs",
	".js",
	".jsx",
	".mjs",
	".ts",
	".tsx",
]);

export type MailboxContractManifest = Readonly<{
	schemaVersion: 1;
	contract: "mailbox-provider-v1";
	version: number;
	protectedPaths: readonly string[];
	protectedDirectories: readonly Readonly<{
		path: string;
		recursive: boolean;
	}>[];
	adapterRoots: readonly string[];
	excludedPathSegments: readonly string[];
	forbiddenModulePrefixes: readonly string[];
	forbiddenProviderUrlFragments: readonly string[];
	normalization: Readonly<{
		encoding: "utf8";
		lineEndings: "lf";
		stripUtf8Bom: true;
		pathOrdering: "ascii-posix-bytewise";
		entryFraming:
			"domain-null-schema-null-version-null-count-null-path-length-null-path-null-content-length-null-content";
	}>;
	hash: Readonly<{
		algorithm: "sha256";
		digest: string;
	}>;
	successRecord: Readonly<{
		format: "canonical-json";
		fields: readonly ["contract", "hash", "status", "version"];
		status: "passed";
	}>;
}>;

export type MailboxContractPin = Readonly<{
	contract: "mailbox-provider-v1";
	version: number;
	hash: string;
	commit: string;
}>;

export type BoundaryViolation = Readonly<{
	file: string;
	line: number;
	form:
		| "fetch"
		| "xml-http-request"
		| "web-socket"
		| "provider-api"
		| "provider-sdk-import"
		| "dynamic-code"
		| "network-module"
		| "network-worker"
		| "dom-exfiltration"
		| "invalid-adapter";
	detail: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === keys.length &&
		actual.every((key, index) => key === [...keys].sort()[index])
	);
}

function strings(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.every((item) => typeof item === "string")
	);
}

function safeRelativePath(value: string): boolean {
	return (
		value.length > 0 &&
		!isAbsolute(value) &&
		!value.split(/[\\/]/u).includes("..") &&
		!value.includes("\\")
	);
}

export function validateMailboxContractManifest(
	value: unknown,
): MailboxContractManifest {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"adapterRoots",
			"contract",
			"excludedPathSegments",
			"forbiddenModulePrefixes",
			"forbiddenProviderUrlFragments",
			"hash",
			"normalization",
			"protectedDirectories",
			"protectedPaths",
			"schemaVersion",
			"successRecord",
			"version",
		]) ||
		value.schemaVersion !== 1 ||
		value.contract !== "mailbox-provider-v1" ||
		!Number.isSafeInteger(value.version) ||
		(value.version as number) < 1 ||
		!strings(value.protectedPaths) ||
		!strings(value.adapterRoots) ||
		!strings(value.excludedPathSegments) ||
		!strings(value.forbiddenModulePrefixes) ||
		!strings(value.forbiddenProviderUrlFragments) ||
		!Array.isArray(value.protectedDirectories) ||
		!value.protectedDirectories.every(
			(item) =>
				isRecord(item) &&
				exactKeys(item, ["path", "recursive"]) &&
				typeof item.path === "string" &&
				typeof item.recursive === "boolean",
		) ||
		!isRecord(value.normalization) ||
		!exactKeys(value.normalization, [
			"encoding",
			"entryFraming",
			"lineEndings",
			"pathOrdering",
			"stripUtf8Bom",
		]) ||
		value.normalization.encoding !== "utf8" ||
		value.normalization.lineEndings !== "lf" ||
		value.normalization.stripUtf8Bom !== true ||
		value.normalization.pathOrdering !== "ascii-posix-bytewise" ||
		value.normalization.entryFraming !==
			"domain-null-schema-null-version-null-count-null-path-length-null-path-null-content-length-null-content" ||
		!isRecord(value.hash) ||
		!exactKeys(value.hash, ["algorithm", "digest"]) ||
		value.hash.algorithm !== "sha256" ||
		typeof value.hash.digest !== "string" ||
		!SHA256.test(value.hash.digest) ||
		!isRecord(value.successRecord) ||
		!exactKeys(value.successRecord, ["fields", "format", "status"]) ||
		value.successRecord.format !== "canonical-json" ||
		value.successRecord.status !== "passed" ||
		!Array.isArray(value.successRecord.fields) ||
		value.successRecord.fields.join(",") !==
			"contract,hash,status,version"
	) {
		throw new Error("Invalid mailbox-provider-v1 manifest");
	}
	const paths = value.protectedPaths as readonly string[];
	const adapterRoots = value.adapterRoots as readonly string[];
	const directories = value.protectedDirectories as readonly Readonly<{
		path: string;
		recursive: boolean;
	}>[];
	if (
		paths.length === 0 ||
		paths.some((path) => !safeRelativePath(path)) ||
		adapterRoots.some((path) => !safeRelativePath(path)) ||
		directories.some((item) => !safeRelativePath(item.path)) ||
		new Set(paths).size !== paths.length ||
		new Set(adapterRoots).size !== adapterRoots.length ||
		new Set(directories.map((item) => item.path)).size !==
			directories.length
	) {
		throw new Error("Mailbox protected paths must be unique and safe");
	}
	return value as MailboxContractManifest;
}

export async function loadMailboxContractManifest(
	repoRoot: string,
	manifestPath = MAILBOX_CONTRACT_MANIFEST,
): Promise<MailboxContractManifest> {
	const source = await readFile(resolve(repoRoot, manifestPath), "utf8");
	return validateMailboxContractManifest(JSON.parse(source) as unknown);
}

function normalizedBytes(source: Uint8Array): Uint8Array {
	let text = new TextDecoder("utf-8", { fatal: true }).decode(source);
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	text = text.replace(/\r\n?/gu, "\n");
	if (text.includes("\0")) {
		throw new Error("Protected files may not contain NUL bytes");
	}
	return new TextEncoder().encode(text);
}

function asciiCompare(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}

export async function resolveProtectedContractPaths(
	repoRoot: string,
	manifest: MailboxContractManifest,
): Promise<readonly string[]> {
	const paths = new Set(manifest.protectedPaths);
	for (const directory of manifest.protectedDirectories) {
		const absolute = resolve(repoRoot, directory.path);
		for (const file of await walkFiles(absolute, directory.recursive)) {
			if (
				manifest.adapterRoots.some((root) =>
					within(resolve(repoRoot, root), file),
				)
			) {
				continue;
			}
			paths.add(posixRelative(repoRoot, file));
		}
	}
	return Object.freeze([...paths].sort(asciiCompare));
}

export async function computeMailboxContractHash(
	repoRoot: string,
	manifest: MailboxContractManifest,
): Promise<string> {
	const hash = createHash("sha256");
	const paths = await resolveProtectedContractPaths(repoRoot, manifest);
	hash.update("DG-MAILBOX-PROVIDER-CONTRACT");
	hash.update("\0");
	hash.update(String(manifest.schemaVersion));
	hash.update("\0");
	hash.update(String(manifest.version));
	hash.update("\0");
	hash.update(JSON.stringify({
		adapterRoots: manifest.adapterRoots,
		excludedPathSegments: manifest.excludedPathSegments,
		forbiddenModulePrefixes: manifest.forbiddenModulePrefixes,
		forbiddenProviderUrlFragments:
			manifest.forbiddenProviderUrlFragments,
		normalization: manifest.normalization,
		protectedDirectories: manifest.protectedDirectories,
		protectedPaths: manifest.protectedPaths,
		successRecord: manifest.successRecord,
	}));
	hash.update("\0");
	hash.update(String(paths.length));
	hash.update("\0");
	for (const path of paths) {
		const pathBytes = Buffer.from(path);
		const bytes = normalizedBytes(await readFile(resolve(repoRoot, path)));
		hash.update(String(pathBytes.byteLength));
		hash.update("\0");
		hash.update(pathBytes);
		hash.update("\0");
		hash.update(String(bytes.byteLength));
		hash.update("\0");
		hash.update(bytes);
	}
	return hash.digest("hex");
}

function extension(path: string): string {
	const match = /\.[^.]+$/u.exec(path);
	return match?.[0] ?? "";
}

async function walkFiles(
	root: string,
	recursive: boolean,
): Promise<readonly string[]> {
	const result: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.isFile()) {
			result.push(resolve(root, entry.name));
		} else if (recursive && entry.isDirectory()) {
			result.push(...await walkFiles(resolve(root, entry.name), true));
		} else if (entry.isSymbolicLink()) {
			throw new Error(
				`Protected trees may not contain symlinks: ${resolve(root, entry.name)}`,
			);
		}
	}
	return result;
}

function posixRelative(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

export async function verifyProtectedInventory(
	repoRoot: string,
	manifest: MailboxContractManifest,
): Promise<void> {
	const canonicalRoot = await realpath(repoRoot);
	for (const path of manifest.protectedPaths) {
		const absolute = resolve(repoRoot, path);
		const info = await lstat(absolute).catch(() => undefined);
		if (info?.isSymbolicLink()) {
			throw new Error(`Protected path is a symlink: ${path}`);
		}
		if (!info?.isFile()) throw new Error(`Missing protected path: ${path}`);
		const canonical = await realpath(absolute);
		if (!within(canonicalRoot, canonical)) {
			throw new Error(`Protected path escapes repository: ${path}`);
		}
	}
	for (const directory of manifest.protectedDirectories) {
		const absolute = resolve(repoRoot, directory.path);
		const info = await lstat(absolute).catch(() => undefined);
		if (info?.isSymbolicLink()) {
			throw new Error(
				`Protected directory is a symlink: ${directory.path}`,
			);
		}
		if (!info?.isDirectory()) {
			throw new Error(`Missing protected directory: ${directory.path}`);
		}
		const canonical = await realpath(absolute);
		if (!within(canonicalRoot, canonical)) {
			throw new Error(
				`Protected directory escapes repository: ${directory.path}`,
			);
		}
		await walkFiles(absolute, directory.recursive);
	}
}

function moduleIsForbidden(
	moduleName: string,
	prefixes: readonly string[],
): boolean {
	const normalized = moduleName.toLowerCase();
	return prefixes.some((prefix) => {
		const candidate = prefix.toLowerCase();
		return (
			normalized === candidate ||
			normalized.startsWith(`${candidate}/`) ||
			normalized.startsWith(`${candidate}-`)
		);
	});
}

function propertyName(node: ts.Node): string | undefined {
	if (ts.isIdentifier(node)) return node.text;
	if (
		ts.isElementAccessExpression(node) &&
		node.argumentExpression !== undefined &&
		ts.isStringLiteralLike(node.argumentExpression)
	) {
		return node.argumentExpression.text;
	}
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	return undefined;
}

const NETWORK_IDENTIFIERS = new Map<
	string,
	BoundaryViolation["form"]
>([
	["EventSource", "network-worker"],
	["Audio", "network-worker"],
	["Image", "network-worker"],
	["RTCPeerConnection", "network-worker"],
	["SharedWorker", "network-worker"],
	["WebSocket", "web-socket"],
	["WebTransport", "network-worker"],
	["Worker", "network-worker"],
	["XMLHttpRequest", "xml-http-request"],
	["Function", "dynamic-code"],
	["eval", "dynamic-code"],
	["fetch", "fetch"],
	["importScripts", "dynamic-code"],
	["require", "network-module"],
	["sendBeacon", "network-worker"],
]);

const EXFILTRATION_PROPERTIES = new Set([
	"action",
	"formAction",
	"href",
	"innerHTML",
	"location",
	"outerHTML",
	"src",
	"srcdoc",
]);
const DYNAMIC_TIMER_IDENTIFIERS = new Set(["setInterval", "setTimeout"]);

function bareModule(value: string): boolean {
	return !value.startsWith(".") && !value.startsWith("/");
}

function importIsTypeOnly(node: ts.ImportDeclaration): boolean {
	const clause = node.importClause;
	if (clause?.isTypeOnly === true) return true;
	if (
		clause?.name === undefined &&
		clause?.namedBindings !== undefined &&
		ts.isNamedImports(clause.namedBindings)
	) {
		return clause.namedBindings.elements.every(
			(element) => element.isTypeOnly,
		);
	}
	return false;
}

function allowedProviderValueImport(node: ts.ImportDeclaration): boolean {
	if (
		!ts.isStringLiteralLike(node.moduleSpecifier) ||
		node.moduleSpecifier.text !== "../config" ||
		node.importClause?.name !== undefined ||
		node.importClause?.namedBindings === undefined ||
		!ts.isNamedImports(node.importClause.namedBindings)
	) {
		return false;
	}
	const values = node.importClause.namedBindings.elements.filter(
		(element) => !element.isTypeOnly,
	);
	return (
		values.length === 1 &&
		(values[0]?.propertyName?.text ?? values[0]?.name.text) ===
			"defineMailboxProvider"
	);
}

function identifierIsPropertyName(node: ts.Identifier): boolean {
	const parent = node.parent;
	return (
		(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
		((ts.isPropertyAssignment(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isPropertySignature(parent) ||
			ts.isMethodSignature(parent)) &&
			parent.name === node)
	);
}

function globalReceiver(node: ts.Expression): boolean {
	return (
		ts.isIdentifier(node) &&
		[
			"Bun",
			"Deno",
			"globalThis",
			"navigator",
			"self",
			"window",
		].includes(node.text)
	);
}

function directNetworkReference(
	node: ts.Identifier,
): BoundaryViolation["form"] | undefined {
	const form = NETWORK_IDENTIFIERS.get(node.text);
	if (form === undefined) return undefined;
	const parent = node.parent;
	if (identifierIsPropertyName(node)) {
		if (
			ts.isPropertyAccessExpression(parent) &&
			globalReceiver(parent.expression)
		) {
			return form;
		}
		return undefined;
	}
	if (
		ts.isBindingElement(parent) &&
		parent.propertyName === node
	) {
		return form;
	}
	return form;
}

export function inspectMailboxAdapterSource(
	source: string,
	file: string,
	manifest: MailboxContractManifest,
): readonly BoundaryViolation[] {
	const syntax = ts.transpileModule(source, {
		fileName: file,
		reportDiagnostics: true,
		compilerOptions: {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
		},
	});
	const parsed = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const violations: BoundaryViolation[] = [];
	const ambient = new Set([
		"Bun",
		"Deno",
		"browser",
		"chrome",
		"frames",
		"globalThis",
		"location",
		"module",
		"navigator",
		"parent",
		"process",
		"Reflect",
		"self",
		"top",
		"window",
	]);
	const tainted = new Map<string, BoundaryViolation["form"]>();
	const add = (
		node: ts.Node,
		form: BoundaryViolation["form"],
		detail: string,
	) => {
		const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
		violations.push({ file, line: position.line + 1, form, detail });
	};
	for (const diagnostic of syntax.diagnostics ?? []) {
		if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
		const start = diagnostic.start ?? 0;
		const position = parsed.getLineAndCharacterOfPosition(start);
		violations.push({
			file,
			line: position.line + 1,
			form: "invalid-adapter",
			detail: ts.flattenDiagnosticMessageText(
				diagnostic.messageText,
				" ",
			),
		});
	}
	const checkModule = (node: ts.Node, value: string) => {
		if (moduleIsForbidden(value, manifest.forbiddenModulePrefixes)) {
			add(node, "provider-sdk-import", value);
		}
	};
	const literalString = (node: ts.Expression): string | undefined => {
		if (ts.isStringLiteralLike(node)) return node.text;
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.PlusToken
		) {
			const left = literalString(node.left);
			const right = literalString(node.right);
			return left === undefined || right === undefined
				? undefined
				: left + right;
		}
		return undefined;
	};
	const rootIdentifier = (node: ts.Expression): string | undefined => {
		if (ts.isIdentifier(node)) return node.text;
		if (
			ts.isPropertyAccessExpression(node) ||
			ts.isElementAccessExpression(node)
		) {
			return rootIdentifier(node.expression);
		}
		return undefined;
	};
	const dangerousMember = (
		name: string | undefined,
	): BoundaryViolation["form"] | undefined => {
		if (name === undefined) return undefined;
		if (name === "constructor" || name === "createElement") {
			return "dynamic-code";
		}
		if (["contentWindow", "defaultView", "view"].includes(name)) {
			return "network-worker";
		}
		if (
			name === "location" ||
			[
				"after",
				"append",
				"appendChild",
				"assign",
				"before",
				"defineProperty",
				"insertAdjacentHTML",
				"insertBefore",
				"prepend",
				"replaceChildren",
				"replaceWith",
				"setAttribute",
				"setAttributeNS",
				"write",
			].includes(name)
		) {
			return "dom-exfiltration";
		}
		return undefined;
	};
	const capability = (
		node: ts.Expression,
	): BoundaryViolation["form"] | undefined => {
		if (ts.isIdentifier(node)) {
			return tainted.get(node.text) ??
				NETWORK_IDENTIFIERS.get(node.text);
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "Reflect" &&
			node.expression.name.text === "get" &&
			node.arguments.length >= 2
		) {
			const root = rootIdentifier(node.arguments[0]!);
			const name = literalString(node.arguments[1]!);
			if (root !== undefined && ambient.has(root)) {
				return name === undefined
					? "network-worker"
					: NETWORK_IDENTIFIERS.get(name) ??
							"network-worker";
			}
		}
		if (
			ts.isPropertyAccessExpression(node) ||
			ts.isElementAccessExpression(node)
		) {
			const root = rootIdentifier(node);
			const name = ts.isPropertyAccessExpression(node)
				? node.name.text
				: node.argumentExpression === undefined
					? undefined
					: literalString(node.argumentExpression);
			const direct = dangerousMember(name);
			if (direct !== undefined) return direct;
			const inherited = capability(node.expression);
			if (inherited !== undefined) return inherited;
			if (root !== undefined && ambient.has(root)) {
				if (root === "chrome" || root === "browser") {
					return "network-worker";
				}
				if (
					root === "location" ||
					(root === "window" && name === "open")
				) {
					return "dom-exfiltration";
				}
				if (
					root === "module" ||
					root === "process" ||
					root === "Deno" ||
					root === "Bun"
				) {
					return "network-module";
				}
				return name === undefined
					? "network-worker"
					: NETWORK_IDENTIFIERS.get(name);
			}
		}
		return undefined;
	};
	const visit = (node: ts.Node): void => {
		if (
			node.parent === parsed &&
			ts.isExpressionStatement(node) &&
			ts.isCallExpression(node.expression) &&
			rootIdentifier(node.expression.expression) === "document"
		) {
			add(node, "invalid-adapter", "top-level side effect");
		}
		if (
			ts.isVariableDeclaration(node) &&
			node.initializer !== undefined
		) {
			if (ts.isIdentifier(node.name)) {
				const root = rootIdentifier(node.initializer);
				if (root !== undefined && ambient.has(root)) {
					ambient.add(node.name.text);
				}
				const form = capability(node.initializer);
				if (form !== undefined) tainted.set(node.name.text, form);
			} else if (
				ts.isObjectBindingPattern(node.name)
			) {
				const root = rootIdentifier(node.initializer);
				const fromAmbient =
					root !== undefined && ambient.has(root);
				for (const element of node.name.elements) {
					const name =
						element.propertyName === undefined
							? element.name.getText(parsed)
							: ts.isComputedPropertyName(
									element.propertyName,
								)
								? literalString(
										element.propertyName.expression,
									)
								: propertyName(element.propertyName);
					const form = dangerousMember(name) ??
						(fromAmbient && name !== undefined
							? NETWORK_IDENTIFIERS.get(name) ??
								"network-worker"
							: undefined);
					if (form !== undefined) {
						if (ts.isIdentifier(element.name)) {
							tainted.set(element.name.text, form);
						}
						add(element, form, name ?? "computed member");
					}
				}
			}
		}
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			checkModule(node.moduleSpecifier, node.moduleSpecifier.text);
			if (
				!importIsTypeOnly(node) &&
				!allowedProviderValueImport(node)
			) {
				add(
					node.moduleSpecifier,
					"network-module",
					node.moduleSpecifier.text,
				);
			} else if (
				importIsTypeOnly(node) &&
				bareModule(node.moduleSpecifier.text) &&
				node.moduleSpecifier.text !== "@dg/common"
			) {
				add(
					node.moduleSpecifier,
					"network-module",
					node.moduleSpecifier.text,
				);
			}
		}
		if (ts.isImportEqualsDeclaration(node)) {
			add(node, "network-module", "import-equals");
		}
		if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
			add(node, "dynamic-code", "export-from");
		}
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		) {
			add(node, "dynamic-code", "dynamic-import");
		}
		if (ts.isCallExpression(node)) {
			const form = capability(node.expression);
			if (form !== undefined) {
				add(node, form, node.expression.getText(parsed));
			}
			if (
				(ts.isPropertyAccessExpression(node.expression) ||
					ts.isElementAccessExpression(node.expression)) &&
				propertyName(node.expression) === "constructor"
			) {
				add(node, "dynamic-code", "callable constructor");
			}
			if (
				(ts.isPropertyAccessExpression(node.expression) &&
					node.expression.name.text === "createElement") ||
				(ts.isElementAccessExpression(node.expression) &&
					node.expression.argumentExpression !== undefined &&
					literalString(
						node.expression.argumentExpression,
					) === "createElement")
			) {
				add(node, "dynamic-code", "document element creation");
			}
			if (
				ts.isIdentifier(node.expression) &&
				node.expression.text === "require"
			) {
				add(node, "dynamic-code", "require");
			}
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === "write" &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === "document"
			) {
				add(node, "dom-exfiltration", "document.write");
			}
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === "insertAdjacentHTML"
			) {
				add(node, "dom-exfiltration", "insertAdjacentHTML");
			}
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === "setAttribute" &&
				node.arguments.length >= 2
			) {
				const name = literalString(node.arguments[0]!);
				if (
					name === undefined ||
					EXFILTRATION_PROPERTIES.has(name)
				) {
					add(node, "dom-exfiltration", "setAttribute");
				}
			}
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === "setAttributeNS" &&
				node.arguments.length >= 3
			) {
				const name = literalString(node.arguments[1]!);
				if (
					name === undefined ||
					EXFILTRATION_PROPERTIES.has(name)
				) {
					add(node, "dom-exfiltration", "setAttributeNS");
				}
			}
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === "Object" &&
				["assign", "defineProperty"].includes(
					node.expression.name.text,
				)
			) {
				add(
					node,
					"dom-exfiltration",
					`Object.${node.expression.name.text}`,
				);
			}
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === "Reflect" &&
				node.expression.name.text === "set"
			) {
				add(node, "dom-exfiltration", "Reflect.set");
			}
			if (
				ts.isIdentifier(node.expression) &&
				["setInterval", "setTimeout"].includes(
					node.expression.text,
				) &&
				node.arguments[0] !== undefined &&
				!ts.isArrowFunction(node.arguments[0]) &&
				!ts.isFunctionExpression(node.arguments[0])
			) {
				add(node, "dynamic-code", node.expression.text);
			}
		}
		if (ts.isNewExpression(node)) {
			const form = capability(node.expression);
			if (form !== undefined) {
				add(node, form, node.expression.getText(parsed));
			}
		}
		if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "Function"
		) {
			add(node, "dynamic-code", "Function");
		}
		if (ts.isIdentifier(node)) {
			if (
				ambient.has(node.text) &&
				!identifierIsPropertyName(node)
			) {
				const form: BoundaryViolation["form"] =
					node.text === "module" ||
					node.text === "process" ||
					node.text === "Deno" ||
					node.text === "Bun"
						? "network-module"
						: node.text === "Reflect"
							? "dynamic-code"
							: "network-worker";
				add(node, form, `ambient:${node.text}`);
			}
			const form = directNetworkReference(node);
			if (form !== undefined) add(node, form, node.text);
			if (DYNAMIC_TIMER_IDENTIFIERS.has(node.text)) {
				const parent = node.parent;
				const safeDirectCall =
					ts.isCallExpression(parent) &&
					parent.expression === node &&
					parent.arguments[0] !== undefined &&
					(ts.isArrowFunction(parent.arguments[0]) ||
						ts.isFunctionExpression(parent.arguments[0]));
				if (!safeDirectCall) {
					add(node, "dynamic-code", `aliased ${node.text}`);
				}
			}
		}
		if (
			ts.isPropertyAccessExpression(node) ||
			ts.isElementAccessExpression(node)
		) {
			const name = ts.isPropertyAccessExpression(node)
				? node.name.text
				: node.argumentExpression === undefined
					? undefined
					: literalString(node.argumentExpression);
			const form = dangerousMember(name);
			if (form !== undefined) {
				add(node, form, `forbidden member:${name}`);
			} else if (
				name === undefined &&
				rootIdentifier(node) === "document"
			) {
				add(node, "network-worker", "computed document member");
			}
		}
		if (
			ts.isElementAccessExpression(node) &&
			globalReceiver(node.expression) &&
			node.argumentExpression !== undefined &&
			ts.isStringLiteralLike(node.argumentExpression)
		) {
			const form = NETWORK_IDENTIFIERS.get(
				node.argumentExpression.text,
			);
			if (form !== undefined) {
				add(node, form, node.argumentExpression.text);
			}
		}
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			["Bun", "Deno"].includes(node.expression.text) &&
			["connect", "listen", "serve", "udpSocket"].includes(
				node.name.text,
			)
		) {
			add(
				node,
				"network-module",
				`${node.expression.text}.${node.name.text}`,
			);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >=
				ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <=
				ts.SyntaxKind.LastAssignment &&
			(ts.isPropertyAccessExpression(node.left) ||
				ts.isElementAccessExpression(node.left))
		) {
			const names: string[] = [];
			let current: ts.Expression = node.left;
			while (
				ts.isPropertyAccessExpression(current) ||
				ts.isElementAccessExpression(current)
			) {
				const name = ts.isPropertyAccessExpression(current)
					? current.name.text
					: current.argumentExpression === undefined
						? undefined
						: literalString(current.argumentExpression);
				if (name !== undefined) names.push(name);
				current = current.expression;
			}
			if (
				names.some((name) =>
					EXFILTRATION_PROPERTIES.has(name) ||
					name.toLowerCase().startsWith("on"),
				)
			) {
				add(node, "dom-exfiltration", names.join("."));
			}
		}
		if (
			ts.isStringLiteralLike(node) ||
			ts.isNoSubstitutionTemplateLiteral(node)
		) {
			const lower = node.text.toLowerCase();
			const providerUrl = manifest.forbiddenProviderUrlFragments.find(
				(fragment) => lower.includes(fragment.toLowerCase()),
			);
			if (providerUrl !== undefined) {
				add(node, "provider-api", providerUrl);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return Object.freeze(violations);
}

function excluded(path: string, manifest: MailboxContractManifest): boolean {
	const segments = path.split("/");
	return (
		manifest.excludedPathSegments.some((segment) =>
			segments.includes(segment),
		) ||
		path.endsWith(".d.ts") ||
		!SOURCE_EXTENSIONS.has(extension(path))
	);
}

export async function inspectMailboxAdapterRoots(
	repoRoot: string,
	manifest: MailboxContractManifest,
): Promise<readonly BoundaryViolation[]> {
	const violations: BoundaryViolation[] = [];
	for (const adapterRoot of manifest.adapterRoots) {
		const absolute = resolve(repoRoot, adapterRoot);
		const info = await stat(absolute).catch(() => undefined);
		if (info === undefined) continue;
		if (!info.isDirectory()) {
			throw new Error(`Adapter root is not a directory: ${adapterRoot}`);
		}
		const names = new Map<string, string>();
		for (const entry of await readdir(absolute, {
			withFileTypes: true,
		})) {
			const path = `${adapterRoot}/${entry.name}`;
			const lowered = entry.name.toLowerCase();
			if (names.has(lowered)) {
				violations.push({
					file: path,
					line: 1,
					form: "invalid-adapter",
					detail: `case-collision:${names.get(lowered)}`,
				});
				continue;
			}
			names.set(lowered, entry.name);
			if (
				entry.name.startsWith(".") ||
				entry.isSymbolicLink() ||
				!entry.isFile() ||
				!entry.name.endsWith(".ts") ||
				entry.name.endsWith(".d.ts") ||
				!/^[a-z][a-z0-9-]{1,62}\.ts$/u.test(entry.name)
			) {
				violations.push({
					file: path,
					line: 1,
					form: "invalid-adapter",
					detail: "adapters must be direct, visible .ts files",
				});
				continue;
			}
			if (excluded(path, manifest)) continue;
			const source = await readFile(resolve(absolute, entry.name), "utf8");
			violations.push(
				...inspectMailboxAdapterSource(source, path, manifest),
			);
			const parsed = ts.createSourceFile(
				path,
				source,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS,
			);
			const defineCalls: ts.CallExpression[] = [];
			const collect = (node: ts.Node): void => {
				if (
					ts.isCallExpression(node) &&
					ts.isIdentifier(node.expression) &&
					node.expression.text === "defineMailboxProvider"
				) {
					defineCalls.push(node);
				}
				ts.forEachChild(node, collect);
			};
			collect(parsed);
			const fileId = entry.name.slice(0, -3);
			const defaultExports = parsed.statements.filter(
				(statement): statement is ts.ExportAssignment =>
					ts.isExportAssignment(statement) &&
					!statement.isExportEquals,
			);
			const runtimeExports = parsed.statements.filter(
				(statement) =>
					ts.isExportDeclaration(statement) ||
					(!ts.isExportAssignment(statement) &&
						ts.canHaveModifiers(statement) &&
						ts.getModifiers(statement)?.some(
							(modifier) =>
								modifier.kind ===
								ts.SyntaxKind.ExportKeyword,
						)),
			);
			const expression = defaultExports[0]?.expression;
			const providerCall =
				expression !== undefined &&
				ts.isCallExpression(expression) &&
				ts.isIdentifier(expression.expression) &&
				expression.expression.text ===
					"defineMailboxProvider" &&
				expression.arguments.length === 1 &&
				ts.isObjectLiteralExpression(expression.arguments[0]!)
						? expression
						: undefined;
			const providerObject = providerCall?.arguments[0];
			const idProperty =
				providerObject !== undefined &&
				ts.isObjectLiteralExpression(providerObject)
					? providerObject.properties.find(
							(property) =>
								ts.isPropertyAssignment(property) &&
								propertyName(property.name) === "id",
						)
					: undefined;
			const providerId =
				idProperty !== undefined &&
				ts.isPropertyAssignment(idProperty) &&
				ts.isStringLiteralLike(idProperty.initializer)
					? idProperty.initializer.text
					: undefined;
			if (
				defaultExports.length !== 1 ||
				runtimeExports.length !== 0 ||
				defineCalls.length !== 1 ||
				defineCalls[0] !== providerCall ||
				providerId !== fileId
			) {
				violations.push({
					file: path,
					line: 1,
					form: "invalid-adapter",
					detail:
						"adapter must directly default-export one defineMailboxProvider with its ASCII filename id",
				});
			}
		}
	}
	return Object.freeze(violations);
}

function validatePin(value: unknown): MailboxContractPin {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["commit", "contract", "hash", "version"]) ||
		value.contract !== "mailbox-provider-v1" ||
		!Number.isSafeInteger(value.version) ||
		typeof value.hash !== "string" ||
		!SHA256.test(value.hash) ||
		typeof value.commit !== "string" ||
		!/^[a-f0-9]{40}$/u.test(value.commit)
	) {
		throw new Error("Invalid external mailbox contract pin");
	}
	return value as MailboxContractPin;
}

function within(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function directAdapterPath(
	path: string,
	manifest: MailboxContractManifest,
): boolean {
	return manifest.adapterRoots.some((root) => {
		const prefix = `${root}/`;
		if (!path.startsWith(prefix)) return false;
		const name = path.slice(prefix.length);
		return (
			!name.includes("/") &&
			/^[a-z][a-z0-9-]{1,62}\.ts$/u.test(name)
		);
	});
}

export async function verifyMailboxContractPin(
	repoRoot: string,
	manifest: MailboxContractManifest,
	pinPath: string,
): Promise<void> {
	const absolute = await realpath(resolve(repoRoot, pinPath));
	for (const adapterRoot of manifest.adapterRoots) {
		const root = await realpath(resolve(repoRoot, adapterRoot)).catch(
			() => resolve(repoRoot, adapterRoot),
		);
		if (within(root, absolute)) {
			throw new Error("Mailbox contract pin must be outside adapter roots");
		}
	}
	const pin = validatePin(
		JSON.parse(await readFile(absolute, "utf8")) as unknown,
	);
	if (
		pin.contract !== manifest.contract ||
		pin.version !== manifest.version ||
		pin.hash !== manifest.hash.digest
	) {
		throw new Error("Mailbox contract pin does not match frozen core");
	}
}

async function runGit(
	repoRoot: string,
	args: readonly string[],
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
	const child = Bun.spawn(["git", ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

export function parseGitNameStatus(
	value: string,
): readonly Readonly<{ status: string; paths: readonly string[] }>[] {
	const fields = value.split("\0");
	if (fields.at(-1) === "") fields.pop();
	const changes: Array<Readonly<{
		status: string;
		paths: readonly string[];
	}>> = [];
	for (let index = 0; index < fields.length;) {
		const status = fields[index++];
		if (status === undefined || !/^[A-Z][0-9]*$/u.test(status)) {
			throw new Error("Malformed git name-status output");
		}
		const pathCount = status.startsWith("R") || status.startsWith("C")
			? 2
			: 1;
		const paths = fields.slice(index, index + pathCount);
		if (
			paths.length !== pathCount ||
			paths.some((path) => !safeRelativePath(path))
		) {
			throw new Error("Malformed git name-status path");
		}
		index += pathCount;
		changes.push({ status, paths: Object.freeze(paths) });
	}
	return Object.freeze(changes);
}

async function adapterFiles(
	repoRoot: string,
	manifest: MailboxContractManifest,
): Promise<readonly string[]> {
	const result: string[] = [];
	for (const root of manifest.adapterRoots) {
		const absolute = resolve(repoRoot, root);
		const info = await stat(absolute).catch(() => undefined);
		if (info === undefined) continue;
		for (const entry of await readdir(absolute, { withFileTypes: true })) {
			if (
				entry.isFile() &&
				!entry.isSymbolicLink() &&
				!entry.name.startsWith(".") &&
				entry.name.endsWith(".ts") &&
				!entry.name.endsWith(".d.ts")
			) {
				result.push(`${root}/${entry.name}`);
			}
		}
	}
	return Object.freeze(result.sort(asciiCompare));
}

export async function verifyAdapterCheckpointDiff(
	repoRoot: string,
	manifest: MailboxContractManifest,
	pinPath: string,
): Promise<void> {
	const pin = validatePin(
		JSON.parse(
			await readFile(resolve(repoRoot, pinPath), "utf8"),
		) as unknown,
	);
	const commit = await runGit(repoRoot, [
		"cat-file",
		"-e",
		`${pin.commit}^{commit}`,
	]);
	if (commit.code !== 0) {
		throw new Error("Pinned mailbox core commit is not resolvable");
	}
	const ancestor = await runGit(repoRoot, [
		"merge-base",
		"--is-ancestor",
		pin.commit,
		"HEAD",
	]);
	if (ancestor.code !== 0) {
		throw new Error("Pinned mailbox core commit is not an ancestor");
	}
	const diff = await runGit(repoRoot, [
		"diff",
		"--name-status",
		"-z",
		"--find-renames",
		pin.commit,
		"--",
	]);
	if (diff.code !== 0) {
		throw new Error(`Unable to inspect mailbox core diff: ${diff.stderr}`);
	}
	const allowed = new Set(await adapterFiles(repoRoot, manifest));
	const absolutePin = resolve(repoRoot, pinPath);
	if (within(repoRoot, absolutePin)) {
		allowed.add(posixRelative(repoRoot, absolutePin));
	}
	for (const change of parseGitNameStatus(diff.stdout)) {
		for (const path of change.paths) {
			if (!allowed.has(path) && !directAdapterPath(path, manifest)) {
				throw new Error(
					`Adapter bundle changed protected path: ${path}`,
				);
			}
		}
	}
	const untracked = await runGit(repoRoot, [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	]);
	if (untracked.code !== 0) {
		throw new Error(
			`Unable to inspect untracked mailbox paths: ${untracked.stderr}`,
		);
	}
	for (const path of untracked.stdout.split("\0").filter(Boolean)) {
		if (!allowed.has(path) && !directAdapterPath(path, manifest)) {
			throw new Error(
				`Adapter bundle changed protected path: ${path}`,
			);
		}
	}
}

export async function checkMailboxBoundaries(
	repoRoot: string,
	options: Readonly<{ pinPath?: string }> = {},
): Promise<MailboxContractManifest> {
	const manifest = await loadMailboxContractManifest(repoRoot);
	await verifyProtectedInventory(repoRoot, manifest);
	const digest = await computeMailboxContractHash(repoRoot, manifest);
	if (digest !== manifest.hash.digest) {
		throw new Error(
			`Mailbox contract hash mismatch: expected ${manifest.hash.digest}, received ${digest}`,
		);
	}
	const violations = await inspectMailboxAdapterRoots(repoRoot, manifest);
	if (violations.length > 0) {
		throw new Error(
			violations
				.map(
					(item) =>
						`${item.file}:${item.line} ${item.form} (${item.detail})`,
				)
				.join("\n"),
		);
	}
	const adapters = await adapterFiles(repoRoot, manifest);
	if (adapters.length > 0 && options.pinPath === undefined) {
		throw new Error("Adapter mode requires an external mailbox core pin");
	}
	if (options.pinPath !== undefined) {
		await verifyMailboxContractPin(repoRoot, manifest, options.pinPath);
		await verifyAdapterCheckpointDiff(
			repoRoot,
			manifest,
			options.pinPath,
		);
	}
	return manifest;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] !== "--check" && args[0] !== "--hash") {
		throw new Error("Usage: check-mailbox-boundaries.ts --check|--hash [--pin path]");
	}
	const pinIndex = args.indexOf("--pin");
	const pinPath = pinIndex < 0 ? undefined : args[pinIndex + 1];
	if (pinIndex >= 0 && pinPath === undefined) {
		throw new Error("--pin requires a path");
	}
	const repoRoot = resolve(import.meta.dir, "../../..");
	const manifest = await loadMailboxContractManifest(repoRoot);
	if (args[0] === "--hash") {
		process.stdout.write(`${await computeMailboxContractHash(repoRoot, manifest)}\n`);
		return;
	}
	await checkMailboxBoundaries(repoRoot, { ...(pinPath ? { pinPath } : {}) });
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Mailbox boundary check failed"}\n`,
		);
		process.exitCode = 1;
	});
}
