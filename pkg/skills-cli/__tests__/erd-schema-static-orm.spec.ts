import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	collectStaticSchema,
	DEFAULT_MAX_FILE_SIZE_BYTES,
	parseEfMigrations,
	parsePrismaSchema,
} from "../src/erd/schema-static";
import { findNodeByLabel, writeScopedFile } from "./cli-fixtures";

let scopeDir: string;

beforeEach(() => {
	scopeDir = mkdtempSync(join(tmpdir(), "erd-schema-static-orm-"));
});

afterEach(() => {
	rmSync(scopeDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): string {
	return writeScopedFile(scopeDir, relPath, content);
}

const findNode = findNodeByLabel;

const PRISMA_FIXTURE = `
model User {
  id    String @id @default(uuid())
  email String
  posts Post[]
}

model Post {
  id       String @id @default(uuid())
  title    String
  authorId String
  author   User   @relation(fields: [authorId], references: [id])
}
`;

describe("parsePrismaSchema", () => {
	test("extracts one DbNode per model block with scalar columns only (relation fields excluded) and DbEdge[] from @relation with confidence proven", () => {
		const schemaPath = writeFile("prisma/schema.prisma", PRISMA_FIXTURE);

		const { nodes, edges } = parsePrismaSchema(schemaPath);

		expect(nodes).toHaveLength(2);
		const user = findNode(nodes, "User");
		const post = findNode(nodes, "Post");
		expect(user).toBeDefined();
		expect(post).toBeDefined();
		expect(user?.source).toBe("static-prisma");
		expect(post?.source).toBe("static-prisma");

		const userColumns = user?.columns.map((c) => c.name).sort();
		expect(userColumns).toEqual(["email", "id"].sort());
		const postColumns = post?.columns.map((c) => c.name).sort();
		expect(postColumns).toEqual(["authorId", "id", "title"].sort());

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			from: expect.stringContaining("Post"),
			to: expect.stringContaining("User"),
			fromColumn: "authorId",
			confidence: "proven",
		});
	});

	test('@@map("table_name") overrides the model name as the DbNode label/id source', () => {
		const schemaPath = writeFile(
			"prisma/schema.prisma",
			`
model User {
  id    String @id
  email String

  @@map("app_users")
}
`,
		);

		const { nodes } = parsePrismaSchema(schemaPath);

		expect(nodes).toHaveLength(1);
		expect(nodes[0]?.label).toBe("app_users");
		expect(nodes[0]?.id).toContain("app_users");
		expect(nodes[0]?.label).not.toBe("User");
	});

	test("a Prisma schema with no @relation fields produces nodes with zero edges, not an error", () => {
		const schemaPath = writeFile(
			"prisma/schema.prisma",
			`
model Widget {
  id   String @id
  name String
}
`,
		);

		let result: ReturnType<typeof parsePrismaSchema> | undefined;
		expect(() => {
			result = parsePrismaSchema(schemaPath);
		}).not.toThrow();

		expect(result!.nodes).toHaveLength(1);
		expect(result!.edges).toHaveLength(0);
	});

	test("a malformed schema.prisma that fails to parse is skipped with an evidence note, not thrown", () => {
		const schemaPath = writeFile(
			"prisma/schema.prisma",
			"model User { id String @id ((( totally not valid prisma $$$ unterminated",
		);

		let result: ReturnType<typeof parsePrismaSchema> | undefined;
		expect(() => {
			result = parsePrismaSchema(schemaPath);
		}).not.toThrow();

		expect(result!.nodes).toHaveLength(0);
		const fileEvidence = result!.evidence.filter((e) => e.type === "file");
		expect(fileEvidence.some((e) => e.ref.includes("schema.prisma") && e.detail)).toBe(true);
	});

	test("a schema.prisma file exceeding the max file size cap is skipped with a file evidence note", () => {
		const padding = `// padding\n${"x".repeat(DEFAULT_MAX_FILE_SIZE_BYTES + 1)}\n`;
		const schemaPath = writeFile("prisma/schema.prisma", `${padding}\nmodel Oversized {\n  id String @id\n}\n`);

		const result = parsePrismaSchema(schemaPath);

		expect(result.nodes).toHaveLength(0);
		const sizeEvidence = result.evidence.find((e) => e.ref.includes("schema.prisma"));
		expect(sizeEvidence?.detail).toContain(String(DEFAULT_MAX_FILE_SIZE_BYTES));
	});
});

const EF_CREATE_USERS = `
using Microsoft.EntityFrameworkCore.Migrations;

public partial class CreateUsers : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "Users",
            columns: table => new
            {
                Id = table.Column<Guid>(nullable: false),
                Email = table.Column<string>(nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_Users", x => x.Id);
            });
    }
}
`;

const EF_CREATE_POSTS_WITH_FK = `
using Microsoft.EntityFrameworkCore.Migrations;

public partial class CreatePosts : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "Posts",
            columns: table => new
            {
                Id = table.Column<Guid>(nullable: false),
                AuthorId = table.Column<Guid>(nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_Posts", x => x.Id);
                table.ForeignKey(
                    name: "FK_Posts_Users_AuthorId",
                    column: x => x.AuthorId,
                    principalTable: "Users",
                    principalColumn: "Id");
            });
    }
}
`;

describe("parseEfMigrations", () => {
	test("extracts DbNode[]/DbEdge[] from CreateTable and .ForeignKey calls", () => {
		writeFile("Migrations/0001_CreateUsers.cs", EF_CREATE_USERS);
		writeFile("Migrations/0002_CreatePosts.cs", EF_CREATE_POSTS_WITH_FK);

		const { nodes, edges } = parseEfMigrations(join(scopeDir, "Migrations"));

		expect(nodes).toHaveLength(2);
		const users = findNode(nodes, "Users");
		const posts = findNode(nodes, "Posts");
		expect(users).toBeDefined();
		expect(posts).toBeDefined();
		expect(users?.source).toBe("static-ef");
		expect(posts?.source).toBe("static-ef");
		expect(users?.columns.map((c) => c.name).sort()).toEqual(["Email", "Id"]);
		expect(posts?.columns.map((c) => c.name).sort()).toEqual(["AuthorId", "Id"]);

		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			from: expect.stringContaining("Posts"),
			to: expect.stringContaining("Users"),
			fromColumn: "AuthorId",
			toColumn: "Id",
			confidence: "proven",
		});
	});

	test("multiple EF migration files touching the same table merge additively (last-wins on collision)", () => {
		writeFile(
			"Migrations/0001_CreateWidgets.cs",
			`
using Microsoft.EntityFrameworkCore.Migrations;

public partial class CreateWidgets : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "Widgets",
            columns: table => new
            {
                Id = table.Column<Guid>(nullable: false),
                Price = table.Column<decimal>(nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_Widgets", x => x.Id);
            });
    }
}
`,
		);
		writeFile(
			"Migrations/0002_AlterWidgets.cs",
			`
using Microsoft.EntityFrameworkCore.Migrations;

public partial class AlterWidgets : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "Price",
            table: "Widgets",
            type: "nvarchar(max)",
            nullable: true);
    }
}
`,
		);

		const { nodes } = parseEfMigrations(join(scopeDir, "Migrations"));

		const widgets = findNode(nodes, "Widgets");
		expect(widgets).toBeDefined();
		expect(widgets?.columns.filter((c) => c.name === "Price")).toHaveLength(1);
		const priceCol = widgets?.columns.find((c) => c.name === "Price");
		expect(priceCol?.dataType.toLowerCase()).toContain("nvarchar");
	});

	test("a malformed EF migration .cs file is skipped with a file evidence note, not thrown", () => {
		writeFile(
			"Migrations/0001_Malformed.cs",
			"migrationBuilder.CreateTable(( totally not valid csharp $$$ unterminated",
		);
		writeFile("Migrations/0002_CreateUsers.cs", EF_CREATE_USERS);

		let result: ReturnType<typeof parseEfMigrations> | undefined;
		expect(() => {
			result = parseEfMigrations(join(scopeDir, "Migrations"));
		}).not.toThrow();

		expect(findNode(result!.nodes, "Users")).toBeDefined();
		const fileEvidence = result!.evidence.filter((e) => e.type === "file");
		expect(fileEvidence.some((e) => e.ref.includes("0001_Malformed.cs") && e.detail)).toBe(true);
	});

	test("an EF CreateTable call with an unbalanced columns brace is skipped with a file evidence note, not silently truncated", () => {
		writeFile(
			"Migrations/0001_Unbalanced.cs",
			`
using Microsoft.EntityFrameworkCore.Migrations;

public partial class Unbalanced : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "Widgets",
            columns: table => new
            {
                Id = table.Column<Guid>(nullable: false)
            constraints: table =>
            {
                table.PrimaryKey("PK_Widgets", x => x.Id);
            });
    }
}
`,
		);
		writeFile("Migrations/0002_CreateUsers.cs", EF_CREATE_USERS);

		let result: ReturnType<typeof parseEfMigrations> | undefined;
		expect(() => {
			result = parseEfMigrations(join(scopeDir, "Migrations"));
		}).not.toThrow();

		expect(findNode(result!.nodes, "Widgets")).toBeUndefined();
		expect(findNode(result!.nodes, "Users")).toBeDefined();
		const fileEvidence = result!.evidence.filter((e) => e.type === "file");
		expect(fileEvidence.some((e) => e.ref.includes("0001_Unbalanced.cs") && e.detail)).toBe(true);
	});

	test("an EF migration .cs file exceeding the max file size cap is skipped with a file evidence note", () => {
		const padding = `// padding\n${"x".repeat(DEFAULT_MAX_FILE_SIZE_BYTES + 1)}\n`;
		writeFile("Migrations/0001_Oversized.cs", `${padding}\n${EF_CREATE_USERS}`);

		const result = parseEfMigrations(join(scopeDir, "Migrations"));

		expect(findNode(result.nodes, "Users")).toBeUndefined();
		const sizeEvidence = result.evidence.find((e) => e.ref.includes("0001_Oversized.cs"));
		expect(sizeEvidence?.detail).toContain(String(DEFAULT_MAX_FILE_SIZE_BYTES));
	});

	test("does not descend into node_modules when discovering EF migration files", () => {
		writeFile(
			"Migrations/node_modules/some-pkg/Migrations/0001_Vendored.cs",
			`
using Microsoft.EntityFrameworkCore.Migrations;

public partial class CreateVendored : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "Vendored",
            columns: table => new { Id = table.Column<Guid>(nullable: false) },
            constraints: table => { table.PrimaryKey("PK_Vendored", x => x.Id); });
    }
}
`,
		);
		writeFile("Migrations/0001_CreateUsers.cs", EF_CREATE_USERS);

		const { nodes } = parseEfMigrations(join(scopeDir, "Migrations"));

		expect(findNode(nodes, "Vendored")).toBeUndefined();
		expect(findNode(nodes, "Users")).toBeDefined();
	});
});

describe("collectStaticSchema", () => {
	test("prefers a Prisma schema over EF migrations, raw SQL, and dbt sources when multiple are present, recording a visibility note", () => {
		writeFile("prisma/schema.prisma", PRISMA_FIXTURE);
		writeFile(
			"models/staging/sources.yml",
			["version: 2", "sources:", "  - name: raw", "    tables:", "      - name: customers"].join("\n"),
		);

		const result = collectStaticSchema(scopeDir);

		expect(findNode(result.nodes, "User")).toBeDefined();
		expect(result.nodes.some((n) => n.source === "static-dbt")).toBe(false);

		const visibilityNote = result.evidence.find(
			(e) => e.type === "file" && e.detail?.startsWith("Static schema parsed from: "),
		);
		expect(visibilityNote).toBeDefined();
		expect(visibilityNote?.detail).toContain("schema.prisma");
		expect(visibilityNote?.detail?.toLowerCase()).toContain("sources.yml");
	});

	test("falls through to EF migrations when no Prisma schema is present but EF migrations exist alongside raw SQL", () => {
		writeFile("Migrations/0001_CreateUsers.cs", EF_CREATE_USERS);
		writeFile("migrations/0001_create_orders.sql", "CREATE TABLE orders (id UUID PRIMARY KEY);");

		const result = collectStaticSchema(scopeDir);

		expect(findNode(result.nodes, "Users")).toBeDefined();
		expect(result.nodes.some((n) => n.source === "static-sql")).toBe(false);
	});

	test("omits the visibility note when only one static format is present", () => {
		writeFile("prisma/schema.prisma", PRISMA_FIXTURE);

		const result = collectStaticSchema(scopeDir);

		const visibilityNote = result.evidence.find((e) => e.detail?.startsWith("Static schema parsed from: "));
		expect(visibilityNote).toBeUndefined();
	});

	test("returns an empty result when no static schema format is present in the scope", () => {
		writeFile("README.md", "# nothing to see here");

		const result = collectStaticSchema(scopeDir);

		expect(result.nodes).toHaveLength(0);
	});

	test("falls through to EF migrations when the higher-precedence Prisma schema is present but malformed (zero nodes)", () => {
		writeFile("prisma/schema.prisma", "model User { id String @id ((( totally not valid prisma $$$ unterminated");
		writeFile("Migrations/0001_CreateUsers.cs", EF_CREATE_USERS);

		const result = collectStaticSchema(scopeDir);

		expect(findNode(result.nodes, "Users")).toBeDefined();
		expect(result.nodes.some((n) => n.source === "static-prisma")).toBe(false);
	});
});
