import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_MAX_FILE_SIZE_BYTES, parseDbtSources, parseSqlMigrations } from "../src/erd/schema-static";

let scopeDir: string;

beforeEach(() => {
	scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), "erd-schema-static-"));
});

afterEach(() => {
	fs.rmSync(scopeDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): string {
	const abs = path.join(scopeDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
	return abs;
}

function findNode<T extends { label: string }>(nodes: T[], label: string): T | undefined {
	return nodes.find((n) => n.label === label);
}

describe("parseSqlMigrations", () => {
	test("extracts one DbNode per CREATE TABLE with columns and types", () => {
		writeFile(
			"migrations/0001_create_users.sql",
			`CREATE TABLE users (
				id UUID PRIMARY KEY,
				email TEXT NOT NULL,
				name TEXT
			);`,
		);

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		expect(nodes).toHaveLength(1);
		const users = findNode(nodes, "users");
		expect(users).toBeDefined();
		expect(users?.source).toBe("static-sql");
		const columnNames = users?.columns.map((c) => c.name).sort();
		expect(columnNames).toEqual(["email", "id", "name"]);
		const idCol = users?.columns.find((c) => c.name === "id");
		expect(idCol?.dataType.toLowerCase()).toContain("uuid");
	});

	test("inline REFERENCES produces a DbEdge with confidence proven", () => {
		writeFile(
			"migrations/0001_create_users.sql",
			`CREATE TABLE users (
				id UUID PRIMARY KEY
			);`,
		);
		writeFile(
			"migrations/0002_create_orders.sql",
			`CREATE TABLE orders (
				id UUID PRIMARY KEY,
				user_id UUID NOT NULL REFERENCES users(id)
			);`,
		);

		const { edges } = parseSqlMigrations({ scopePath: scopeDir });

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			from: expect.stringContaining("orders"),
			to: expect.stringContaining("users"),
			fromColumn: "user_id",
			toColumn: "id",
			confidence: "proven",
		});
	});

	test("FOREIGN KEY ... REFERENCES clause produces a DbEdge with confidence proven", () => {
		writeFile(
			"migrations/0001_create_orders.sql",
			`CREATE TABLE orders (
				id UUID PRIMARY KEY
			);`,
		);
		writeFile(
			"migrations/0002_create_payments.sql",
			`CREATE TABLE payments (
				id UUID PRIMARY KEY,
				order_id UUID NOT NULL,
				FOREIGN KEY (order_id) REFERENCES orders(id)
			);`,
		);

		const { edges } = parseSqlMigrations({ scopePath: scopeDir });

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			from: expect.stringContaining("payments"),
			to: expect.stringContaining("orders"),
			fromColumn: "order_id",
			toColumn: "id",
			confidence: "proven",
		});
	});

	test("named CONSTRAINT ... FOREIGN KEY ... REFERENCES clause produces a DbEdge with confidence proven", () => {
		writeFile(
			"migrations/0001_create_orders.sql",
			`CREATE TABLE orders (
				id UUID PRIMARY KEY
			);`,
		);
		writeFile(
			"migrations/0002_create_payments.sql",
			`CREATE TABLE payments (
				id UUID PRIMARY KEY,
				order_id UUID NOT NULL,
				CONSTRAINT fk_payments_order_id FOREIGN KEY (order_id) REFERENCES orders(id)
			);`,
		);

		const { edges } = parseSqlMigrations({ scopePath: scopeDir });

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			from: expect.stringContaining("payments"),
			to: expect.stringContaining("orders"),
			fromColumn: "order_id",
			toColumn: "id",
			confidence: "proven",
		});
	});

	test("multiple migration files touching the same table merge into one DbNode (additive union)", () => {
		writeFile(
			"migrations/0001_create_widgets.sql",
			`CREATE TABLE widgets (
				id UUID PRIMARY KEY,
				name TEXT
			);`,
		);
		writeFile("migrations/0002_alter_widgets.sql", "ALTER TABLE widgets ADD COLUMN price NUMERIC;");

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		expect(nodes).toHaveLength(1);
		const widgets = findNode(nodes, "widgets");
		const columnNames = widgets?.columns.map((c) => c.name).sort();
		expect(columnNames).toEqual(["id", "name", "price"]);
	});

	test("last-migration-wins on a column-name collision across merged files", () => {
		writeFile(
			"migrations/0001_create_widgets.sql",
			`CREATE TABLE widgets (
				id UUID PRIMARY KEY,
				price NUMERIC
			);`,
		);
		writeFile("migrations/0002_alter_widgets.sql", "ALTER TABLE widgets ADD COLUMN price VARCHAR(255);");

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		const widgets = findNode(nodes, "widgets");
		const priceCol = widgets?.columns.find((c) => c.name === "price");
		expect(widgets?.columns.filter((c) => c.name === "price")).toHaveLength(1);
		expect(priceCol?.dataType.toLowerCase()).toContain("varchar");
	});

	test("a migration file with no CREATE/ALTER TABLE statement contributes no nodes and does not error", () => {
		writeFile(
			"migrations/0001_seed_data.sql",
			"INSERT INTO users (id, email) VALUES ('11111111-1111-1111-1111-111111111111', 'a@b.com');",
		);

		expect(() => parseSqlMigrations({ scopePath: scopeDir })).not.toThrow();
		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });
		expect(nodes).toHaveLength(0);
	});

	test("uses the default migration globs when migrationGlobs is omitted", () => {
		writeFile("migrations/0001_create_users.sql", "CREATE TABLE users (id UUID PRIMARY KEY);");
		writeFile("db/migrations/0001_create_orders.sql", "CREATE TABLE orders (id UUID PRIMARY KEY);");

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		expect(findNode(nodes, "users")).toBeDefined();
		expect(findNode(nodes, "orders")).toBeDefined();
	});

	test("a file outside the default globs (and outside any custom migrationGlobs) is not scanned", () => {
		writeFile("schema/not_a_migration.sql", "CREATE TABLE ghost (id UUID PRIMARY KEY);");

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		expect(findNode(nodes, "ghost")).toBeUndefined();
	});

	test("a malformed SQL file is skipped with a file evidence note, not thrown", () => {
		writeFile("migrations/0001_malformed.sql", "CREATE TABLE (( totally not valid sql $$$ unterminated 'string");
		writeFile("migrations/0002_create_users.sql", "CREATE TABLE users (id UUID PRIMARY KEY);");

		let result: ReturnType<typeof parseSqlMigrations> | undefined;
		expect(() => {
			result = parseSqlMigrations({ scopePath: scopeDir });
		}).not.toThrow();

		expect(findNode(result!.nodes, "users")).toBeDefined();
		const fileEvidence = result!.evidence.filter((e) => e.type === "file");
		expect(fileEvidence.some((e) => e.ref.includes("0001_malformed.sql") && e.detail)).toBe(true);
	});

	test("a migration file exceeding the max file size cap is skipped with a file evidence note, not read in full", () => {
		const oversizedSql = `-- padding\n${"x".repeat(DEFAULT_MAX_FILE_SIZE_BYTES + 1)}\nCREATE TABLE oversized (id UUID PRIMARY KEY);`;
		writeFile("migrations/0001_oversized.sql", oversizedSql);
		writeFile("migrations/0002_create_users.sql", "CREATE TABLE users (id UUID PRIMARY KEY);");

		const result = parseSqlMigrations({ scopePath: scopeDir });

		expect(findNode(result.nodes, "oversized")).toBeUndefined();
		expect(findNode(result.nodes, "users")).toBeDefined();
		const sizeEvidence = result.evidence.find((e) => e.ref.includes("0001_oversized.sql"));
		expect(sizeEvidence?.detail).toContain(String(DEFAULT_MAX_FILE_SIZE_BYTES));
	});

	test("respects a custom migrationGlobs list instead of the defaults", () => {
		writeFile("custom-sql/0001_create_widgets.sql", "CREATE TABLE widgets (id UUID PRIMARY KEY);");
		writeFile("migrations/0001_create_users.sql", "CREATE TABLE users (id UUID PRIMARY KEY);");

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir, migrationGlobs: ["**/custom-sql/**/*.sql"] });

		expect(findNode(nodes, "widgets")).toBeDefined();
		expect(findNode(nodes, "users")).toBeUndefined();
	});

	test("does not descend into node_modules when discovering migration files", () => {
		writeFile("node_modules/some-pkg/migrations/0001_vendored.sql", "CREATE TABLE vendored (id UUID PRIMARY KEY);");
		writeFile("migrations/0001_create_users.sql", "CREATE TABLE users (id UUID PRIMARY KEY);");

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		expect(findNode(nodes, "vendored")).toBeUndefined();
		expect(findNode(nodes, "users")).toBeDefined();
	});
});

describe("parseDbtSources", () => {
	test("extracts one DbNode per declared table from a fixture sources.yml, with no edges", () => {
		writeFile(
			"models/staging/sources.yml",
			[
				"version: 2",
				"sources:",
				"  - name: raw",
				"    tables:",
				"      - name: customers",
				"      - name: events",
			].join("\n"),
		);

		const result = parseDbtSources(scopeDir);

		expect(result.nodes).toHaveLength(2);
		const labels = result.nodes.map((n) => n.label).sort();
		expect(labels).toEqual(["customers", "events"]);
		for (const node of result.nodes) {
			expect(node.source).toBe("static-dbt");
		}
		expect("edges" in result).toBe(false);
	});

	test("returns an empty result when no sources.yml/.yaml is found", () => {
		writeFile("models/staging/schema.sql", "CREATE TABLE unrelated (id UUID PRIMARY KEY);");

		const result = parseDbtSources(scopeDir);

		expect(result.nodes).toHaveLength(0);
		expect(result.evidence).toEqual([]);
	});

	test("uses the declared source name as the DbNode schema", () => {
		writeFile(
			"models/staging/sources.yml",
			["version: 2", "sources:", "  - name: raw", "    tables:", "      - name: customers"].join("\n"),
		);

		const result = parseDbtSources(scopeDir);

		expect(result.nodes[0]?.schema).toBe("raw");
	});

	test("a sources.yml file exceeding the max file size cap is skipped with a file evidence note", () => {
		const padding = "# padding\n".repeat(Math.ceil((DEFAULT_MAX_FILE_SIZE_BYTES + 1) / "# padding\n".length));
		writeFile(
			"models/staging/sources.yml",
			`${padding}\nversion: 2\nsources:\n  - name: raw\n    tables:\n      - name: customers`,
		);

		const result = parseDbtSources(scopeDir);

		expect(result.nodes).toHaveLength(0);
		const sizeEvidence = result.evidence.find((e) => e.ref.includes("sources.yml"));
		expect(sizeEvidence?.detail).toContain(String(DEFAULT_MAX_FILE_SIZE_BYTES));
	});

	test("does not descend into node_modules when discovering sources.yml files", () => {
		writeFile(
			"node_modules/some-pkg/models/staging/sources.yml",
			["version: 2", "sources:", "  - name: raw", "    tables:", "      - name: vendored_table"].join("\n"),
		);

		const result = parseDbtSources(scopeDir);

		expect(result.nodes.map((n) => n.label)).not.toContain("vendored_table");
	});
});
