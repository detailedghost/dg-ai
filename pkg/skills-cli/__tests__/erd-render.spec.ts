import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFromData } from "../src/erd";
import type { ArchitectureGraph, ClassRenderData, SequenceRenderData, StateRenderData } from "../src/erd/graph";
import {
	buildClassDiagram,
	buildImportFlowchart,
	buildSchemaErDiagram,
	buildSequenceDiagram,
	buildStateDiagram,
	MERMAID_CDN_URL,
	renderHtml,
} from "../src/erd/render";

const graph: ArchitectureGraph = {
	scope: "fixture",
	codeNodes: [
		{ id: "src/app.ts", label: "app.ts", kind: "file" },
		{ id: "src/store.ts", label: "store.ts", kind: "file" },
	],
	codeEdges: [{ from: "src/app.ts", to: "src/store.ts", kind: "import", evidence: "line 1" }],
	dbNodes: [
		{
			id: "public.users",
			label: "users",
			schema: "public",
			source: "static-sql",
			columns: [
				{ name: "id", dataType: "uuid", nullable: false, isPrimaryKey: true },
				{ name: "org_id", dataType: "uuid", nullable: false, isForeignKey: true },
			],
		},
		{
			id: "public.orgs",
			label: "orgs",
			schema: "public",
			source: "static-sql",
			columns: [{ name: "id", dataType: "uuid", nullable: false, isPrimaryKey: true }],
		},
	],
	dbEdges: [{ from: "public.users", to: "public.orgs", fromColumn: "org_id", toColumn: "id", confidence: "proven" }],
	crossLinks: [],
	evidence: [],
	truncated: { codeNodes: 0, codeEdges: 0, dbNodes: 0 },
	generatedAt: new Date(0).toISOString(),
};

const sequence: SequenceRenderData = {
	participants: ["Browser", "API"],
	messages: [
		{ from: "Browser", to: "API", label: "request", kind: "sync" },
		{ from: "API", to: "Browser", label: "response", kind: "return" },
	],
};

const state: StateRenderData = {
	states: ["Idle", "Running"],
	initial: "Idle",
	transitions: [{ from: "Idle", to: "Running", label: "start" }],
};

const classes: ClassRenderData = {
	classes: [
		{ name: "User", fields: ["id: uuid"], methods: ["save()"] },
		{ name: "Admin" },
	],
	relations: [{ from: "Admin", to: "User", kind: "extends" }],
};

describe("Mermaid golden output", () => {
	test("flow", () => {
		expect(buildImportFlowchart(graph)).toBe(
			'graph LR\n  src_app_ts["app.ts"]\n  src_store_ts["store.ts"]\n  src_app_ts -->|import| src_store_ts',
		);
	});

	test("er", () => {
		expect(buildSchemaErDiagram(graph)).toBe(
			'erDiagram\n  public_users }o--|| public_orgs : "id"\n  public_users {\n    uuid id PK\n    uuid org_id FK\n  }\n  public_orgs {\n    uuid id PK\n  }',
		);
	});

	test("sequence", () => {
		expect(buildSequenceDiagram(sequence)).toBe(
			'sequenceDiagram\n  participant Browser as "Browser"\n  participant API as "API"\n  Browser->>API: request\n  API-->>Browser: response',
		);
	});

	test("state", () => {
		expect(buildStateDiagram(state)).toBe(
			'stateDiagram-v2\n  state "Idle" as Idle\n  state "Running" as Running\n  [*] --> Idle\n  Idle --> Running : start',
		);
	});

	test("class", () => {
		expect(buildClassDiagram(classes)).toBe(
			'classDiagram\n  class User["User"] {\n    +id: uuid\n    +save()\n  }\n  class Admin["Admin"] {\n  }\n  User <|-- Admin : extends',
		);
	});
});

describe("Mermaid grammar validation", () => {
	let mermaid: typeof import("mermaid").default;

	beforeAll(async () => {
		const { Window } = await import("happy-dom");
		const win = new Window();
		Object.defineProperty(globalThis, "window", { configurable: true, value: win });
		Object.defineProperty(globalThis, "document", { configurable: true, value: win.document });
		mermaid = (await import("mermaid")).default;
	});

	afterAll(() => {
		Reflect.deleteProperty(globalThis, "window");
		Reflect.deleteProperty(globalThis, "document");
	});

	async function parses(diagram: string): Promise<boolean> {
		try {
			await mermaid.parse(diagram, { suppressErrors: false });
			return true;
		} catch {
			return false;
		}
	}

	test("every builder's output parses as real Mermaid", async () => {
		const diagrams = [
			buildImportFlowchart(graph),
			buildSchemaErDiagram(graph),
			buildSequenceDiagram(sequence),
			buildStateDiagram(state),
			buildClassDiagram(classes),
		];
		for (const diagram of diagrams) {
			expect(await parses(diagram)).toBe(true);
		}
	});

	test("rejects the old missing-cardinality and quoted-attribute ER forms", async () => {
		expect(await parses('erDiagram\n  a {\n    uuid id PK\n  }\n  b {\n    uuid id PK\n  }\n  a --o{ b : "id"')).toBe(
			false,
		);
		expect(await parses('erDiagram\n  a {\n    "uuid" "id" PK\n  }')).toBe(false);
	});

	test("sanitizes attribute words with a leading digit, hyphen, quote, parens, brackets, or spaces", async () => {
		const weird: ArchitectureGraph = {
			...graph,
			dbNodes: [
				{
					id: "public.things",
					label: "things",
					schema: "public",
					source: "static-sql",
					columns: [
						{ name: "2fa_code", dataType: "uuid", nullable: false },
						{ name: "my-col", dataType: "varchar(255)", nullable: true },
						{ name: "tags", dataType: "int[]", nullable: true },
						{ name: "created_at", dataType: "timestamp with time zone", nullable: false },
						{ name: 'col"x', dataType: "text", nullable: true },
					],
				},
			],
			dbEdges: [],
		};
		expect(await parses(buildSchemaErDiagram(weird))).toBe(true);
	});
});

describe("standalone HTML", () => {
	test("has a dark-mode theme and no external asset except the single pinned Mermaid module", () => {
		const html = renderHtml([{ diagram: buildSequenceDiagram(sequence), title: "Calls" }], "Calls");
		expect(html).toContain("prefers-color-scheme: dark");
		expect(html).toContain(MERMAID_CDN_URL);
		const externalUrls = html.match(/https:\/\/[^"'\s<]+/g) ?? [];
		expect(externalUrls).toEqual([MERMAID_CDN_URL]);
		expect(html).not.toMatch(/<(?:img|link)[^>]+(?:src|href)=/i);
	});

	test("the HTML option persists the selected diagram beside Markdown and JSON", async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-erd-html-"));
		try {
			const result = await renderFromData({
				type: "sequence",
				data: sequence,
				outPath: join(root, "calls"),
				html: true,
			});
			expect(result.htmlOutPath).toBe(join(root, "calls.html"));
			const html = readFileSync(result.htmlOutPath as string, "utf8");
			expect(html.match(/https:\/\/[^"'\s<]+/g)).toEqual([MERMAID_CDN_URL]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
