import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtemp,
	mkdir,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	checkMailboxBoundaries,
	computeMailboxContractHash,
	inspectMailboxAdapterRoots,
	inspectMailboxAdapterSource,
	loadMailboxContractManifest,
	parseGitNameStatus,
	resolveProtectedContractPaths,
	validateMailboxContractManifest,
	verifyAdapterCheckpointDiff,
	verifyMailboxContractPin,
	verifyProtectedInventory,
	type MailboxContractManifest,
} from "../scripts/check-mailbox-boundaries";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) =>
			rm(root, { recursive: true, force: true }),
		),
	);
});

function manifest(
	digest = "0".repeat(64),
	version = 1,
): MailboxContractManifest {
	return {
		schemaVersion: 1,
		contract: "mailbox-provider-v1",
		version,
		protectedPaths: ["core/a.ts"],
		protectedDirectories: [{ path: "core", recursive: true }],
		adapterRoots: ["adapters"],
		excludedPathSegments: ["__tests__", "fixtures", "generated"],
		forbiddenModulePrefixes: [
			"@azure/msal",
			"@microsoft/microsoft-graph",
		],
		forbiddenProviderUrlFragments: ["graph.microsoft.com"],
		normalization: {
			encoding: "utf8",
			lineEndings: "lf",
			stripUtf8Bom: true,
			pathOrdering: "ascii-posix-bytewise",
			entryFraming:
				"domain-null-schema-null-version-null-count-null-path-length-null-path-null-content-length-null-content",
		},
		hash: { algorithm: "sha256", digest },
		successRecord: {
			format: "canonical-json",
			fields: ["contract", "hash", "status", "version"],
			status: "passed",
		},
	};
}

async function fixture(content = "export const value = 1;\n") {
	const root = await mkdtemp(join(tmpdir(), "dg-mailbox-boundary-"));
	roots.push(root);
	await mkdir(join(root, "core"));
	await writeFile(join(root, "core/a.ts"), content);
	return root;
}

function adapterSource(id: string): string {
	return `
		import { defineMailboxProvider } from "../config";
		export default defineMailboxProvider({ id: "${id}" });
	`;
}

async function git(root: string, ...args: readonly string[]) {
	const child = Bun.spawn(["git", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
	return stdout.trim();
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function repositoryFixture(
	options: Readonly<{ baselineAdapter?: string }> = {},
) {
	const root = await fixture();
	await mkdir(join(root, "adapters"));
	if (options.baselineAdapter !== undefined) {
		await writeFile(
			join(root, `adapters/${options.baselineAdapter}.ts`),
			adapterSource(options.baselineAdapter),
		);
	}
	const initial = manifest();
	const frozen = {
		...initial,
		hash: {
			...initial.hash,
			digest: await computeMailboxContractHash(root, initial),
		},
	} satisfies MailboxContractManifest;
	await mkdir(join(root, "pkg/extension"), { recursive: true });
	await writeJson(
		join(root, "pkg/extension/mailbox-provider-v1.json"),
		frozen,
	);
	await git(root, "init");
	await git(root, "config", "user.email", "mailbox-core@example.invalid");
	await git(root, "config", "user.name", "Mailbox Core Test");
	await git(root, "add", ".");
	await git(root, "commit", "-m", "mailbox core checkpoint");
	const commit = await git(root, "rev-parse", "HEAD");
	const pinPath = "mailbox-provider-v1.pin.json";
	await writeJson(join(root, pinPath), {
		contract: frozen.contract,
		version: frozen.version,
		hash: frozen.hash.digest,
		commit,
	});
	return { commit, manifest: frozen, pinPath, root };
}

describe("mailbox-provider-v1 protected contract", () => {
	it("normalizes line endings but hashes version, inventory, path, and bytes", async () => {
		const root = await fixture("\ufeffa\r\nb\r\n");
		const lfHash = await computeMailboxContractHash(root, manifest());
		await writeFile(join(root, "core/a.ts"), "a\nb\n");
		expect(await computeMailboxContractHash(root, manifest())).toBe(lfHash);
		expect(
			await computeMailboxContractHash(root, manifest(undefined, 2)),
		).not.toBe(lfHash);
		await writeFile(join(root, "core/a.ts"), "changed\n");
		expect(await computeMailboxContractHash(root, manifest())).not.toBe(
			lfHash,
		);
	});

	it("sorts resolved paths bytewise and rejects NUL or invalid UTF-8", async () => {
		const root = await fixture();
		await writeFile(join(root, "core/B.ts"), "export {};\n");
		await writeFile(join(root, "core/a2.ts"), "export {};\n");
		expect(await resolveProtectedContractPaths(root, manifest())).toEqual([
			"core/B.ts",
			"core/a.ts",
			"core/a2.ts",
		]);

		await writeFile(join(root, "core/a.ts"), "before\0after");
		await expect(
			computeMailboxContractHash(root, manifest()),
		).rejects.toThrow(/NUL/i);
		await writeFile(
			join(root, "core/a.ts"),
			new Uint8Array([0xc3, 0x28]),
		);
		await expect(
			computeMailboxContractHash(root, manifest()),
		).rejects.toThrow();
	});

	it("rejects unknown manifest fields, unsafe paths, and duplicate inventory", () => {
		expect(() =>
			validateMailboxContractManifest({
				...manifest(),
				unknown: true,
			}),
		).toThrow();
		expect(() =>
			validateMailboxContractManifest({
				...manifest(),
				protectedPaths: ["core/a.ts", "core/a.ts"],
			}),
		).toThrow(/unique/i);
		for (const protectedPath of [
			"/absolute.ts",
			"../outside.ts",
			"core\\outside.ts",
		]) {
			expect(
				() =>
					validateMailboxContractManifest({
						...manifest(),
						protectedPaths: [protectedPath],
					}),
				protectedPath,
			).toThrow();
		}
		const acceptedDuplicates: string[] = [];
		for (const [name, value] of [
			[
				"adapter roots",
				{
					...manifest(),
					adapterRoots: ["adapters", "adapters"],
				},
			],
			[
				"protected directories",
				{
					...manifest(),
					protectedDirectories: [
						{ path: "core", recursive: true },
						{ path: "core", recursive: true },
					],
				},
			],
		] as const) {
			try {
				validateMailboxContractManifest(value);
				acceptedDuplicates.push(name);
			} catch {
				// Expected: duplicate policy inventory is not canonical.
			}
		}
		expect(acceptedDuplicates).toEqual([]);
	});

	it("detects protected additions, removals, and renames through the aggregate hash", async () => {
		const root = await fixture();
		const baseline = await computeMailboxContractHash(root, manifest());
		await writeFile(join(root, "core/b.ts"), "export {};\n");
		expect(await computeMailboxContractHash(root, manifest())).not.toBe(
			baseline,
		);
		await rm(join(root, "core/a.ts"));
		await expect(
			verifyProtectedInventory(root, manifest()),
		).rejects.toThrow(/missing protected path/i);
	});

	it("excludes nested adapter bytes without excluding provider-root helpers", async () => {
		const root = await fixture();
		await mkdir(join(root, "providers/adapters"), {
			recursive: true,
		});
		await writeFile(
			join(root, "providers/contracts.ts"),
			"export type Contract = unknown;\n",
		);
		const nestedManifest = {
			...manifest(),
			protectedDirectories: [
				{ path: "core", recursive: true },
				{ path: "providers", recursive: true },
			],
			adapterRoots: ["providers/adapters"],
		} satisfies MailboxContractManifest;
		const baseline = await computeMailboxContractHash(
			root,
			nestedManifest,
		);

		await writeFile(
			join(root, "providers/adapters/mail.ts"),
			adapterSource("mail"),
		);
		expect(
			await computeMailboxContractHash(root, nestedManifest),
		).toBe(baseline);
		await writeFile(
			join(root, "providers/adapters/mail.ts"),
			`${adapterSource("mail")}\nconst changed = true;\n`,
		);
		expect(
			await computeMailboxContractHash(root, nestedManifest),
		).toBe(baseline);

		await writeFile(
			join(root, "providers/helper.ts"),
			"export const helper = true;\n",
		);
		expect(
			await computeMailboxContractHash(root, nestedManifest),
		).not.toBe(baseline);
	});

	it("rejects direct, root, and nested symlinks in protected inventory", async () => {
		const direct = await fixture();
		await writeFile(join(direct, "outside.ts"), "export {};\n");
		await rm(join(direct, "core/a.ts"));
		await symlink("../outside.ts", join(direct, "core/a.ts"));
		await expect(
			verifyProtectedInventory(direct, manifest()),
		).rejects.toThrow(/symlink/i);

		const rootLink = await fixture();
		await rename(join(rootLink, "core"), join(rootLink, "actual-core"));
		await symlink("actual-core", join(rootLink, "core"));
		await expect(
			verifyProtectedInventory(rootLink, manifest()),
		).rejects.toThrow(/symlink/i);

		const nested = await fixture();
		await writeFile(join(nested, "outside.ts"), "export {};\n");
		await symlink("../outside.ts", join(nested, "core/link.ts"));
		await expect(
			verifyProtectedInventory(nested, manifest()),
		).rejects.toThrow(/symlink/i);
	});

	it("protects every runtime, gate, and conformance input", async () => {
		const repoRoot = resolve(import.meta.dir, "../../..");
		const actual = await loadMailboxContractManifest(repoRoot);
		const paths = new Set(
			await resolveProtectedContractPaths(repoRoot, actual),
		);
		const required = [
			"pkg/common/package.json",
			"pkg/common/src/index.ts",
			"pkg/extension/__tests__/mailbox-core-conformance-harness.ts",
			"pkg/extension/__tests__/mailbox-plan-page-fixtures.ts",
			"pkg/extension/__tests__/mailbox-plan-page-harness.ts",
			"pkg/extension/bun.lock",
			"pkg/extension/lib/background/index.ts",
			"pkg/extension/scripts/copy-ort.ts",
			"pkg/extension/scripts/mailbox-core-tests.ts",
			"pkg/extension/tsconfig.json",
			"pkg/extension/wxt.config.ts",
		];
		expect(required.filter((path) => !paths.has(path))).toEqual([]);
		expect(actual.protectedDirectories).toContainEqual({
			path: "pkg/extension/entrypoints",
			recursive: true,
		});
	});
});

describe("mailbox adapter source boundary", () => {
	const positive = [
		'import client from "@microsoft/microsoft-graph-client";',
		'import http = require("node:https");',
		'const client = await import("@azure/msal-browser");',
		'const client = require("node:https");',
		"const request = fetch; request('/mail');",
		"const { fetch: request } = globalThis; request('/mail');",
		"globalThis['fetch']('/mail');",
		"fetch.call(globalThis, '/mail');",
		"new XMLHttpRequest();",
		"new WebSocket('wss://mail');",
		"new EventSource('/events');",
		"new WebTransport('https://mail');",
		"navigator.sendBeacon('/mail', data);",
		"new RTCPeerConnection();",
		"importScripts('/worker.js');",
		"new Worker('/worker.js');",
		"eval(source);",
		"new Function(source);",
		"document.write(secret);",
		"node.src = secret;",
		"export { provider } from './helper';",
		"const endpoint = 'https://graph.microsoft.com/v1.0/me';",
		"const g = globalThis; g.fetch('/mail');",
		"const w = window; const request = w.fetch; request('/mail');",
		"const { ['fetch']: f } = globalThis; f('/x');",
		"let g; g = globalThis; g.fetch('/x');",
		"const g = globalThis; function run(f = g.fetch) { f('/x'); }",
		"const box = { g: globalThis }; box.g.fetch('/x');",
		"globalThis['fe' + 'tch']('/mail');",
		"const request = Reflect.get(globalThis, 'fetch'); request('/mail');",
		"module.require('node:https');",
		"process.getBuiltinModule('node:https');",
		"Deno.connectTls({ hostname: 'mail', port: 443 });",
		"const g = globalThis; new g.WebSocket('wss://mail');",
		"const g = globalThis; const X = g.XMLHttpRequest; new X();",
		"const build = Function; build(source);",
		"const later = setTimeout; later(source, 0);",
		"const repeat = setInterval; repeat(source, 0);",
		"(() => undefined).constructor(source)();",
		"const build = function noop() {}.constructor; build(source)();",
		"const load = require; load('node:https');",
		"chrome.tabs.create({ url: 'https://example.com' });",
		"window.open('https://example.com');",
		"location.assign('https://example.com');",
		"document.location.assign(secret);",
		"document.location.replace(secret);",
		"node.setAttribute('src', secret);",
		"function run(node) { node['set' + 'Attribute']('src', secret); }",
		"function run(node) { const set = node.setAttribute.bind(node); set('src', secret); }",
		"function run(node) { Element.prototype.setAttribute.call(node, 'src', secret); }",
		"function run(node) { const define = Object.defineProperty; define(node, 'src', { value: secret }); }",
		"node['s' + 'rc'] = secret;",
		"Object.defineProperty(node, 'src', { value: secret });",
		"node.attributes.src.value = secret;",
		"node.setAttributeNS(null, 'src', secret);",
		"top.fetch('/x');",
		"parent.fetch('/x');",
		"frames.fetch('/x');",
		"navigator.serviceWorker.register(secret);",
		"const sw = navigator.serviceWorker; sw.register(secret);",
		"navigator.serviceWorker.controller?.postMessage(secret);",
		"Reflect.get(document.defaultView, 'fetch')('/x');",
		"function run() { const g = document.defaultView; g.fetch('/x'); }",
		"const fixture = { run() { document.defaultView.fetch('/x'); } };",
		'function run(){ const { defaultView: w } = document; w.fetch("/x") }',
		'function run(){ const [w]=[document.defaultView]; w.fetch("/x") }',
		"function run(node) { node.ownerDocument.defaultView.fetch('/x'); }",
		"function run(event) { event.view.fetch('/x'); }",
		'function run(node){ const { setAttribute: set } = node; set.call(node,"src",secret) }',
		'function run(node){ const [set]=[node.setAttribute]; set.call(node,"src",secret) }',
		'function run(node){ const { defineProperty: d } = Object; d(node,"src",{value:secret}) }',
		"new Image();",
		"new Audio(secret);",
		"new SharedWorker('/worker.js');",
		"function run() { const script = document.createElement('script'); script.text = secret; document.head.append(script); }",
		'function run(){ const make=document.createElement.bind(document); const s=make("script"); s.text=code; document.head.insertBefore(s,null) }',
		'function run(){ const [make]=[document.createElement]; const s=make.call(document,"script"); s.text=code; const [insert]=[document.head.insertBefore]; insert.call(document.head,s,null) }',
		"function run(node) { node.setAttribute('onclick', secret); }",
	] as const;

	it("rejects every network, SDK, dynamic-code, and DOM-exfiltration form", () => {
		const accepted = positive.filter(
			(source) =>
				inspectMailboxAdapterSource(
					source,
					"adapters/provider.ts",
					manifest(),
				).length === 0,
		);
		expect(accepted).toEqual([]);
	});

	it("accepts benign type, comment, string, and object method lookalikes", () => {
		const source = `
			import type { MailboxProvider } from "@dg/common";
			// fetch("https://graph.microsoft.com")
			type FetchState = { ready: boolean };
			const prefetch = true;
			const text = "fetch is not invoked";
			const fixture = {
				fetch() { return text; },
				run() {
					fixture.fetch();
					const node =
						document.querySelector("[data-message-id]");
					node?.textContent;
					node?.click();
					new MutationObserver(() => undefined);
					AbortSignal.timeout(100);
					setTimeout(() => undefined, 0);
				},
			};
			export default fixture satisfies { fetch(): string };
		`;
		expect(
			inspectMailboxAdapterSource(
				source,
				"adapters/provider.ts",
				manifest(),
			),
		).toEqual([]);
	});

	it("rejects malformed syntax before policy inspection", () => {
		expect(
			inspectMailboxAdapterSource(
				"export default {",
				"adapters/provider.ts",
				manifest(),
			),
		).toEqual([
			expect.objectContaining({ form: "invalid-adapter" }),
		]);
	});

	it("accepts one direct valid adapter and rejects structural escapes", async () => {
		const valid = await fixture();
		await mkdir(join(valid, "adapters"));
		await writeFile(
			join(valid, "adapters/mail.ts"),
			adapterSource("mail"),
		);
		expect(
			await inspectMailboxAdapterRoots(valid, manifest()),
		).toEqual([]);

		const cases = [
			{
				name: "nested directory",
				setup: async (root: string) => {
					await mkdir(join(root, "adapters/nested"));
				},
			},
			{
				name: "symlink",
				setup: async (root: string) => {
					await writeFile(
						join(root, "mail.ts"),
						adapterSource("mail"),
					);
					await symlink(
						"../mail.ts",
						join(root, "adapters/mail.ts"),
					);
				},
			},
			{
				name: "hidden file",
				setup: (root: string) =>
					writeFile(
						join(root, "adapters/.mail.ts"),
						adapterSource("mail"),
					),
			},
			{
				name: "non-TypeScript file",
				setup: (root: string) =>
					writeFile(join(root, "adapters/mail.js"), "export {};\n"),
			},
			{
				name: "declaration file",
				setup: (root: string) =>
					writeFile(
						join(root, "adapters/mail.d.ts"),
						"export {};\n",
					),
			},
			{
				name: "case collision",
				setup: async (root: string) => {
					await writeFile(
						join(root, "adapters/mail.ts"),
						adapterSource("mail"),
					);
					await writeFile(
						join(root, "adapters/MAIL.ts"),
						adapterSource("MAIL"),
					);
				},
			},
			{
				name: "non-ASCII provider id",
				setup: (root: string) =>
					writeFile(
						join(root, "adapters/é.ts"),
						adapterSource("é"),
					),
			},
			{
				name: "filename and provider id mismatch",
				setup: (root: string) =>
					writeFile(
						join(root, "adapters/mail.ts"),
						adapterSource("other"),
					),
			},
			{
				name: "multiple provider declarations",
				setup: (root: string) =>
					writeFile(
						join(root, "adapters/mail.ts"),
						`${adapterSource("mail")}\ndefineMailboxProvider({ id: "mail" });`,
					),
			},
			{
				name: "provider declaration is not the default export",
				setup: (root: string) =>
					writeFile(
						join(root, "adapters/mail.ts"),
						`
							import { defineMailboxProvider } from "../config";
							defineMailboxProvider({ id: "mail" });
							export default {};
						`,
					),
			},
			{
				name: "extra named runtime export",
				setup: (root: string) =>
					writeFile(
						join(root, "adapters/mail.ts"),
						`${adapterSource("mail")}\nexport const helper = 1;`,
					),
			},
			{
				name: "top-level side effect",
				setup: (root: string) =>
					writeFile(
						join(root, "adapters/mail.ts"),
						`${adapterSource("mail")}\ndocument.body.click();`,
					),
			},
			{
				name: "aliased define import",
				setup: (root: string) =>
					writeFile(
						join(root, "adapters/mail.ts"),
						`
							import {
								defineMailboxProvider as define,
							} from "../config";
							export default define({ id: "mail" });
						`,
					),
			},
		] as const;
		const accepted: string[] = [];
		for (const test of cases) {
			const root = await fixture();
			await mkdir(join(root, "adapters"));
			await test.setup(root);
			if (
				!(await inspectMailboxAdapterRoots(root, manifest())).some(
					(item) => item.form === "invalid-adapter",
				)
			) {
				accepted.push(test.name);
			}
		}
		expect(accepted).toEqual([]);
	});

	it("retains both rename endpoints from NUL-delimited git output", () => {
		expect(
			parseGitNameStatus(
				"R100\0core/old.ts\0core/new.ts\0M\0adapters/mail.ts\0",
			),
		).toEqual([
			{
				status: "R100",
				paths: ["core/old.ts", "core/new.ts"],
			},
			{ status: "M", paths: ["adapters/mail.ts"] },
		]);
		for (const malformed of [
			"M\0",
			"R100\0core/old.ts\0",
			"modified\0core/a.ts\0",
			"M\0../outside.ts\0",
		]) {
			expect(() => parseGitNameStatus(malformed), malformed).toThrow();
		}
	});
});

describe("mailbox adapter checkpoint pin", () => {
	it("accepts the exact checkpoint and rejects malformed or mismatched pins", async () => {
		const test = await repositoryFixture();
		await expect(
			verifyMailboxContractPin(
				test.root,
				test.manifest,
				test.pinPath,
			),
		).resolves.toBeUndefined();
		await expect(
			verifyAdapterCheckpointDiff(
				test.root,
				test.manifest,
				test.pinPath,
			),
		).resolves.toBeUndefined();

		for (const badPin of [
			{
				contract: "mailbox-provider-v2",
				version: 1,
				hash: test.manifest.hash.digest,
				commit: test.commit,
			},
			{
				contract: "mailbox-provider-v1",
				version: 2,
				hash: test.manifest.hash.digest,
				commit: test.commit,
			},
			{
				contract: "mailbox-provider-v1",
				version: 1,
				hash: "f".repeat(64),
				commit: test.commit,
			},
			{
				contract: "mailbox-provider-v1",
				version: 1,
				hash: test.manifest.hash.digest,
				commit: test.commit.slice(0, 12),
			},
			{
				contract: "mailbox-provider-v1",
				version: 1,
				hash: test.manifest.hash.digest,
				commit: test.commit,
				unknown: true,
			},
		] as const) {
			await writeJson(join(test.root, test.pinPath), badPin);
			await expect(
				verifyMailboxContractPin(
					test.root,
					test.manifest,
					test.pinPath,
				),
			).rejects.toThrow();
		}

		const pinInsideAdapter = "adapters/mailbox-provider-v1.pin.json";
		await writeJson(join(test.root, pinInsideAdapter), {
			contract: test.manifest.contract,
			version: test.manifest.version,
			hash: test.manifest.hash.digest,
			commit: test.commit,
		});
		await expect(
			verifyMailboxContractPin(
				test.root,
				test.manifest,
				pinInsideAdapter,
			),
		).rejects.toThrow(/outside adapter/i);
	});

	it("rejects an unresolved or non-ancestor full checkpoint commit", async () => {
		const unresolved = await repositoryFixture();
		await writeJson(join(unresolved.root, unresolved.pinPath), {
			contract: unresolved.manifest.contract,
			version: unresolved.manifest.version,
			hash: unresolved.manifest.hash.digest,
			commit: "f".repeat(40),
		});
		await expect(
			verifyAdapterCheckpointDiff(
				unresolved.root,
				unresolved.manifest,
				unresolved.pinPath,
			),
		).rejects.toThrow(/resolvable/i);

		const nonAncestor = await repositoryFixture();
		await git(nonAncestor.root, "checkout", "--orphan", "unrelated");
		await git(nonAncestor.root, "add", ".");
		await git(nonAncestor.root, "commit", "-m", "unrelated branch");
		const unrelatedCommit = await git(
			nonAncestor.root,
			"rev-parse",
			"HEAD",
		);
		await git(nonAncestor.root, "checkout", "master");
		await writeJson(join(nonAncestor.root, nonAncestor.pinPath), {
			contract: nonAncestor.manifest.contract,
			version: nonAncestor.manifest.version,
			hash: nonAncestor.manifest.hash.digest,
			commit: unrelatedCommit,
		});
		await expect(
			verifyAdapterCheckpointDiff(
				nonAncestor.root,
				nonAncestor.manifest,
				nonAncestor.pinPath,
			),
		).rejects.toThrow(/ancestor/i);
	});

	it("allows adapter-only additions and edits", async () => {
		const added = await repositoryFixture();
		await writeFile(
			join(added.root, "adapters/mail.ts"),
			adapterSource("mail"),
		);
		await expect(
			verifyAdapterCheckpointDiff(
				added.root,
				added.manifest,
				added.pinPath,
			),
		).resolves.toBeUndefined();

		const changed = await repositoryFixture({
			baselineAdapter: "mail",
		});
		await writeFile(
			join(changed.root, "adapters/mail.ts"),
			`${adapterSource("mail")}\nexport const changed = true;\n`,
		);
		await expect(
			verifyAdapterCheckpointDiff(
				changed.root,
				changed.manifest,
				changed.pinPath,
			),
		).resolves.toBeUndefined();
	});

	it("allows adapter-only deletions and renames", async () => {
		const removed = await repositoryFixture({
			baselineAdapter: "mail",
		});
		await rm(join(removed.root, "adapters/mail.ts"));
		await expect(
			verifyAdapterCheckpointDiff(
				removed.root,
				removed.manifest,
				removed.pinPath,
			),
		).resolves.toBeUndefined();

		const renamed = await repositoryFixture({
			baselineAdapter: "mail",
		});
		await rename(
			join(renamed.root, "adapters/mail.ts"),
			join(renamed.root, "adapters/webmail.ts"),
		);
		await writeFile(
			join(renamed.root, "adapters/webmail.ts"),
			adapterSource("webmail"),
		);
		await expect(
			verifyAdapterCheckpointDiff(
				renamed.root,
				renamed.manifest,
				renamed.pinPath,
			),
		).resolves.toBeUndefined();
	});

	it("rejects every protected edit, addition, deletion, and rename form", async () => {
		const protectedChanges = [
			[
				"edit",
				async (root: string) => {
					await writeFile(join(root, "core/a.ts"), "changed\n");
				},
			],
			[
				"addition",
				async (root: string) => {
					await writeFile(
						join(root, "core/added.ts"),
						"export {};\n",
					);
					await git(root, "add", "core/added.ts");
				},
			],
			[
				"deletion",
				async (root: string) => {
					await rm(join(root, "core/a.ts"));
				},
			],
			[
				"rename within protected tree",
				async (root: string) => {
					await rename(
						join(root, "core/a.ts"),
						join(root, "core/renamed.ts"),
					);
				},
			],
			[
				"rename from protected tree to adapter root",
				async (root: string) => {
					await rename(
						join(root, "core/a.ts"),
						join(root, "adapters/a.ts"),
					);
				},
			],
			[
				"manifest edit",
				async (root: string) => {
					await writeFile(
						join(
							root,
							"pkg/extension/mailbox-provider-v1.json",
						),
						"{}\n",
					);
				},
			],
		] as const;
		const acceptedProtectedChanges: string[] = [];
		for (const [name, change] of protectedChanges) {
			const test = await repositoryFixture();
			await change(test.root);
			try {
				await verifyAdapterCheckpointDiff(
					test.root,
					test.manifest,
					test.pinPath,
				);
				acceptedProtectedChanges.push(name);
			} catch {
				// Expected: no protected path change is an adapter change.
			}
		}
		expect(acceptedProtectedChanges).toEqual([]);

		const staged = await repositoryFixture();
		await writeFile(join(staged.root, "core/a.ts"), "staged\n");
		await git(staged.root, "add", "core/a.ts");
		await expect(
			verifyAdapterCheckpointDiff(
				staged.root,
				staged.manifest,
				staged.pinPath,
			),
		).rejects.toThrow(/protected path/i);

		const crossBoundary = await repositoryFixture({
			baselineAdapter: "mail",
		});
		await rename(
			join(crossBoundary.root, "adapters/mail.ts"),
			join(crossBoundary.root, "core/provider.ts"),
		);
		await expect(
			verifyAdapterCheckpointDiff(
				crossBoundary.root,
				crossBoundary.manifest,
				crossBoundary.pinPath,
			),
		).rejects.toThrow(/protected path/i);
	});

	it("requires a pin in adapter mode and scans untracked protected additions", async () => {
		const core = await repositoryFixture();
		await expect(
			checkMailboxBoundaries(core.root),
		).resolves.toEqual(core.manifest);

		await writeFile(
			join(core.root, "adapters/mail.ts"),
			adapterSource("mail"),
		);
		await expect(
			checkMailboxBoundaries(core.root),
		).rejects.toThrow(/requires an external/i);
		await expect(
			checkMailboxBoundaries(core.root, {
				pinPath: core.pinPath,
			}),
		).resolves.toEqual(core.manifest);
		await writeFile(
			join(core.root, "adapters/mail.ts"),
			"fetch('/mail');\n",
		);
		await expect(
			checkMailboxBoundaries(core.root, {
				pinPath: core.pinPath,
			}),
		).rejects.toThrow(/fetch/i);

		const protectedAddition = await repositoryFixture();
		await writeFile(
			join(protectedAddition.root, "core/untracked.ts"),
			"export {};\n",
		);
		await expect(
			checkMailboxBoundaries(protectedAddition.root),
		).rejects.toThrow(/hash mismatch/i);
	});
});
