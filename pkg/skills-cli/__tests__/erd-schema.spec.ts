import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectLiveSchema } from "../src/erd/schema-live";
import { collectStaticSchema, parseDbtSources, parseEfMigrations, parsePrismaSchema, parseSqlMigrations } from "../src/erd/schema-static";

const fixtures = join(import.meta.dir, "fixtures", "erd");

describe("static schema collectors", () => {
	test("parses SQL migrations and their foreign key", () => {
		const result = parseSqlMigrations({ scopePath: join(fixtures, "sql") });
		expect(result.nodes.map((node) => node.label).sort()).toEqual(["orgs", "users"]);
		expect(result.edges).toEqual([
			{
				from: "public.users",
				to: "public.orgs",
				fromColumn: "org_id",
				toColumn: "id",
				confidence: "proven",
			},
		]);
	});

	test("parses Prisma, EF Core, and dbt sources", () => {
		const prisma = parsePrismaSchema(join(fixtures, "prisma", "schema.prisma"));
		expect(prisma.nodes.map((node) => node.label).sort()).toEqual(["orgs", "users"]);
		expect(prisma.edges).toHaveLength(1);
		expect(parseEfMigrations(join(fixtures, "ef", "Migrations")).nodes[0]?.label).toBe("Orgs");
		expect(parseDbtSources(join(fixtures, "dbt")).nodes.map((node) => node.id)).toEqual([
			"warehouse.orgs",
			"warehouse.users",
		]);
	});

	test("uses the first non-empty static format", () => {
		const result = collectStaticSchema(join(fixtures, "prisma"));
		expect(result.nodes.every((node) => node.source === "static-prisma")).toBe(true);
	});
});

describe("live schema self-dispatch seam", () => {
	test("enumerates tab-separated connections and calls schema without the stale format flag", async () => {
		const calls: string[][] = [];
		const result = await collectLiveSchema({
			runDb: async (argv) => {
				calls.push(argv);
				if (argv[0] === "connections") {
					return { ok: true, stdout: "CONNECTIONS: 1\nname\tengine\ttarget\nmain\tpostgresql\tlocalhost\n" };
				}
				return {
					ok: true,
					stdout: JSON.stringify({
						tables: [{ name: "users", schema: "public", columns: [], foreignKeys: [] }],
					}),
				};
			},
		});
		expect(calls).toEqual([["connections"], ["schema", "main"]]);
		expect(result.usedConnection).toBe("main");
	});

	test("records evidence instead of silently falling back when a live schema response is not valid JSON", async () => {
		const result = await collectLiveSchema({
			runDb: async (argv) => {
				if (argv[0] === "connections") {
					return { ok: true, stdout: "CONNECTIONS: 1\nname\tengine\ttarget\nmain\tpostgresql\tlocalhost\n" };
				}
				return { ok: true, stdout: "not json" };
			},
		});
		expect(result.nodes).toEqual([]);
		expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0]?.ref).toBe("main");
		expect(result.evidence[0]?.detail).toContain("not valid JSON");
	});

	test("records evidence when a live schema response does not match the expected shape", async () => {
		const result = await collectLiveSchema({
			runDb: async (argv) => {
				if (argv[0] === "connections") {
					return { ok: true, stdout: "CONNECTIONS: 1\nname\tengine\ttarget\nmain\tpostgresql\tlocalhost\n" };
				}
				return { ok: true, stdout: JSON.stringify({ notTables: [] }) };
			},
		});
		expect(result.nodes).toEqual([]);
		expect(result.evidence[0]?.detail).toContain("did not match the expected shape");
	});
});
