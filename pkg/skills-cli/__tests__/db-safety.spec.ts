import { describe, expect, test } from "bun:test";
import { classifySql } from "../src/db/safety";

describe("classifySql", () => {
	test.each([
		["SELECT * FROM users", true],
		["SHOW TABLES", true],
		["DESCRIBE users", true],
		["SET timezone = 'UTC'", true],
		["EXPLAIN SELECT * FROM users", true],
		["DELETE FROM users", false],
		["EXPLAIN ANALYZE SELECT * FROM users", false],
	])("classifies %p as allowed=%p", (sql, allowed) => {
		expect(classifySql(sql, false).allowed).toBe(allowed);
	});

	test("blocks DML inside a CTE body", () => {
		const result = classifySql(
			"WITH deleted AS (DELETE FROM users RETURNING id) SELECT * FROM deleted",
			false,
		);
		expect(result).toEqual({
			allowed: false,
			reason: "CTE contains write operations — use --write",
		});
	});

	test("blocks a final write statement after read-only CTEs", () => {
		expect(
			classifySql(
				"WITH ids AS (SELECT id FROM users) UPDATE users SET active = true",
				false,
			),
		).toEqual({
			allowed: false,
			reason: "CTE contains write operations — use --write",
		});
	});

	test("blocks top-level SELECT INTO", () => {
		expect(classifySql("SELECT id INTO archived_users FROM users", false)).toEqual({
			allowed: false,
			reason: "SELECT INTO creates a table — use --write",
		});
	});

	test("does not mistake nested SELECT INTO for a top-level construct", () => {
		expect(
			classifySql(
				"SELECT id FROM users WHERE id IN (SELECT id INTO scratch FROM old_users)",
				false,
			).allowed,
		).toBe(true);
	});

	test("blocks SET followed by a write statement", () => {
		expect(classifySql("SET x = 1; DROP TABLE users", false)).toEqual({
			allowed: false,
			reason: "multiple statements detected — use --write to allow",
		});
	});

	test("keeps a bare SET read-only", () => {
		expect(classifySql("SET x = 1", false)).toEqual({ allowed: true });
	});

	test("ignores semicolons and write keywords inside literals and comments", () => {
		expect(
			classifySql(
				"SELECT 'DROP; DELETE', \"INTO\" FROM users /* UPDATE users */",
				false,
			),
		).toEqual({ allowed: true });
	});

	test("--write allows statements rejected by the read-safe classifier", () => {
		expect(classifySql("SELECT id INTO archived_users FROM users", true)).toEqual({
			allowed: true,
		});
	});
});
