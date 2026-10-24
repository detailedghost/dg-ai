import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MAX_FILE_SIZE_BYTES, parseDbtSources, parseSqlMigrations } from "../src/erd/schema-static";
import { findNodeByLabel, writeScopedFile } from "./cli-fixtures";

let scopeDir: string;

beforeEach(() => {
	scopeDir = mkdtempSync(join(tmpdir(), "erd-schema-static-"));
});

afterEach(() => {
	rmSync(scopeDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): string {
	return writeScopedFile(scopeDir, relPath, content);
}

const findNode = findNodeByLabel;

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

	test("extracts a table from a schema-qualified CREATE TABLE statement", () => {
		writeFile(
			"migrations/0001_create_users.sql",
			`CREATE TABLE "public"."users" (
				id UUID PRIMARY KEY,
				email TEXT NOT NULL
			);`,
		);

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		expect(nodes).toHaveLength(1);
		const users = findNode(nodes, "users");
		expect(users).toBeDefined();
		const columnNames = users?.columns.map((c) => c.name).sort();
		expect(columnNames).toEqual(["email", "id"]);
	});

	test("same-named tables in two different schemas do not merge into one node", () => {
		writeFile(
			"migrations/0001_create_auth_users.sql",
			`CREATE TABLE "auth"."users" (
				id UUID PRIMARY KEY,
				password_hash TEXT NOT NULL
			);`,
		);
		writeFile(
			"migrations/0002_create_public_users.sql",
			`CREATE TABLE "public"."users" (
				id UUID PRIMARY KEY,
				display_name TEXT NOT NULL
			);`,
		);

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		expect(nodes).toHaveLength(2);
		const authUsers = nodes.find((n) => n.id === "auth.users");
		const publicUsers = nodes.find((n) => n.id === "public.users");
		expect(authUsers).toBeDefined();
		expect(publicUsers).toBeDefined();
		expect(authUsers?.schema).toBe("auth");
		expect(publicUsers?.schema).toBe("public");
		expect(authUsers?.columns.map((c) => c.name).sort()).toEqual(["id", "password_hash"]);
		expect(publicUsers?.columns.map((c) => c.name).sort()).toEqual(["display_name", "id"]);
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

	test("an unqualified FK target resolves to the referencing table's own schema when it lives there", () => {
		writeFile(
			"migrations/0001_create_auth_accounts.sql",
			`CREATE TABLE "auth"."accounts" (
				id UUID PRIMARY KEY
			);`,
		);
		writeFile(
			"migrations/0002_create_auth_sessions.sql",
			`CREATE TABLE "auth"."sessions" (
				id UUID PRIMARY KEY,
				account_id UUID NOT NULL REFERENCES accounts(id)
			);`,
		);

		const { edges } = parseSqlMigrations({ scopePath: scopeDir });

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			from: "auth.sessions",
			to: "auth.accounts",
			fromColumn: "account_id",
			toColumn: "id",
		});
	});

	test("an unqualified FK target ambiguous between its own schema and public is downgraded to inferred confidence", () => {
		writeFile(
			"migrations/0001_create_auth_accounts.sql",
			`CREATE TABLE "auth"."accounts" (
				id UUID PRIMARY KEY
			);`,
		);
		writeFile(
			"migrations/0002_create_public_accounts.sql",
			`CREATE TABLE "public"."accounts" (
				id UUID PRIMARY KEY
			);`,
		);
		writeFile(
			"migrations/0003_create_auth_sessions.sql",
			`CREATE TABLE "auth"."sessions" (
				id UUID PRIMARY KEY,
				account_id UUID NOT NULL REFERENCES accounts(id)
			);`,
		);

		const { edges, evidence } = parseSqlMigrations({ scopePath: scopeDir });

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			from: "auth.sessions",
			to: "auth.accounts",
			fromColumn: "account_id",
			toColumn: "id",
			confidence: "inferred",
		});
		expect(
			evidence.some(
				(e) => e.ref === "auth.sessions" && e.detail?.includes("ambiguous target"),
			),
		).toBe(true);
	});

	test("an unqualified FK target found in neither its own schema nor public falls back to public with inferred confidence", () => {
		writeFile(
			"migrations/0001_create_auth_sessions.sql",
			`CREATE TABLE "auth"."sessions" (
				id UUID PRIMARY KEY,
				account_id UUID NOT NULL REFERENCES accounts(id)
			);`,
		);

		const { edges, evidence } = parseSqlMigrations({ scopePath: scopeDir });

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			from: "auth.sessions",
			to: "public.accounts",
			fromColumn: "account_id",
			toColumn: "id",
			confidence: "inferred",
		});
		expect(
			evidence.some(
				(e) => e.ref === "auth.sessions" && e.detail?.includes("account_id") && e.detail?.includes("not found"),
			),
		).toBe(true);
	});

	test("a schema-qualified FK target resolves to its own schema, not the referencing table's", () => {
		writeFile(
			"migrations/0001_create_auth_accounts.sql",
			`CREATE TABLE "auth"."accounts" (
				id UUID PRIMARY KEY
			);`,
		);
		writeFile(
			"migrations/0002_create_billing_invoices.sql",
			`CREATE TABLE "billing"."invoices" (
				id UUID PRIMARY KEY,
				account_id UUID NOT NULL REFERENCES "auth"."accounts"(id)
			);`,
		);

		const { edges } = parseSqlMigrations({ scopePath: scopeDir });

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			from: "billing.invoices",
			to: "auth.accounts",
			fromColumn: "account_id",
			toColumn: "id",
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

	test("an unbalanced parenthesis inside a quoted DEFAULT literal does not truncate the CREATE TABLE body", () => {
		writeFile(
			"migrations/0001_create_items.sql",
			`CREATE TABLE items (
				id UUID PRIMARY KEY,
				note TEXT DEFAULT 'closing)',
				name TEXT
			);`,
		);

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		const items = findNode(nodes, "items");
		const columnNames = items?.columns.map((c) => c.name).sort();
		expect(columnNames).toEqual(["id", "name", "note"]);
	});

	test("detects a trailing NOT NULL on an ALTER TABLE ADD COLUMN statement", () => {
		writeFile("migrations/0001_create_widgets.sql", "CREATE TABLE widgets (id UUID PRIMARY KEY);");
		writeFile("migrations/0002_alter_widgets.sql", "ALTER TABLE widgets ADD COLUMN sku TEXT NOT NULL;");

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		const sku = findNode(nodes, "widgets")?.columns.find((c) => c.name === "sku");
		expect(sku?.nullable).toBe(false);
	});

	test("an ALTER TABLE ADD CONSTRAINT statement does not discard the file's CREATE TABLE data", () => {
		writeFile(
			"migrations/0001_create_tables.sql",
			`CREATE TABLE orders (
				id UUID PRIMARY KEY
			);
			CREATE TABLE payments (
				id UUID PRIMARY KEY,
				order_id UUID NOT NULL
			);
			ALTER TABLE payments ADD CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(id);`,
		);

		const { nodes } = parseSqlMigrations({ scopePath: scopeDir });

		expect(findNode(nodes, "orders")).toBeDefined();
		expect(findNode(nodes, "payments")).toBeDefined();
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

	test("starts a new group when a second source begins while the first source's tables block is still open", () => {
		writeFile(
			"models/staging/sources.yml",
			[
				"version: 2",
				"sources:",
				"  - name: raw",
				"    tables:",
				"      - name: customers",
				"      - name: events",
				"  - name: analytics",
				"    tables:",
				"      - name: sessions",
			].join("\n"),
		);

		const result = parseDbtSources(scopeDir);

		const schemaByLabel = new Map(result.nodes.map((n) => [n.label, n.schema]));
		expect(schemaByLabel.get("customers")).toBe("raw");
		expect(schemaByLabel.get("events")).toBe("raw");
		expect(schemaByLabel.get("sessions")).toBe("analytics");
		expect(result.nodes).toHaveLength(3);
	});

	test("does not mistake a table's nested columns for sibling tables", () => {
		writeFile(
			"models/staging/sources.yml",
			[
				"version: 2",
				"sources:",
				"  - name: raw",
				"    tables:",
				"      - name: customers",
				"        columns:",
				"          - name: id",
				"          - name: email",
				"      - name: events",
			].join("\n"),
		);

		const result = parseDbtSources(scopeDir);

		const labels = result.nodes.map((n) => n.label).sort();
		expect(labels).toEqual(["customers", "events"]);
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
