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

	test("keeps SET SESSION on an ordinary variable read-only", () => {
		expect(classifySql("SET SESSION statement_timeout = 5000", false)).toEqual({
			allowed: true,
		});
	});

	test("blocks SET ROLE", () => {
		expect(classifySql("SET ROLE admin", false)).toEqual({
			allowed: false,
			reason: "SET ROLE/SESSION AUTHORIZATION changes session privileges — use --write",
		});
	});

	test("blocks SET SESSION AUTHORIZATION", () => {
		expect(classifySql("SET SESSION AUTHORIZATION admin", false)).toEqual({
			allowed: false,
			reason: "SET ROLE/SESSION AUTHORIZATION changes session privileges — use --write",
		});
	});

	test("blocks lowercase and mixed-case SET ROLE", () => {
		expect(classifySql("set role admin", false)).toEqual({
			allowed: false,
			reason: "SET ROLE/SESSION AUTHORIZATION changes session privileges — use --write",
		});
	});

	test("blocks SET SESSION ROLE", () => {
		expect(classifySql("SET SESSION ROLE admin", false)).toEqual({
			allowed: false,
			reason: "SET ROLE/SESSION AUTHORIZATION changes session privileges — use --write",
		});
	});

	test("blocks SET LOCAL ROLE", () => {
		expect(classifySql("SET LOCAL ROLE admin", false)).toEqual({
			allowed: false,
			reason: "SET ROLE/SESSION AUTHORIZATION changes session privileges — use --write",
		});
	});

	test("blocks SET LOCAL SESSION AUTHORIZATION", () => {
		expect(classifySql("SET LOCAL SESSION AUTHORIZATION admin", false)).toEqual({
			allowed: false,
			reason: "SET ROLE/SESSION AUTHORIZATION changes session privileges — use --write",
		});
	});

	test("blocks the session_authorization GUC form", () => {
		expect(classifySql("SET session_authorization = 'admin'", false)).toEqual({
			allowed: false,
			reason: "SET ROLE/SESSION AUTHORIZATION changes session privileges — use --write",
		});
	});

	test("keeps SET LOCAL on an ordinary variable read-only", () => {
		expect(classifySql("SET LOCAL search_path TO app", false)).toEqual({ allowed: true });
	});

	test("--write allows SET ROLE", () => {
		expect(classifySql("SET ROLE admin", true)).toEqual({ allowed: true });
	});

	test("ignores semicolons and write keywords inside literals and comments", () => {
		expect(
			classifySql(
				"SELECT 'DROP; DELETE', \"INTO\" FROM users /* UPDATE users */",
				false,
			),
		).toEqual({ allowed: true });
	});

	test("a trailing backslash does not escape the closing quote of a plain string", () => {
		expect(
			classifySql("SELECT 'a\\'; DROP TABLE users", false),
		).toEqual({
			allowed: false,
			reason: "multiple statements detected — use --write to allow",
		});
	});

	test("--write allows statements rejected by the read-safe classifier", () => {
		expect(classifySql("SELECT id INTO archived_users FROM users", true)).toEqual({
			allowed: true,
		});
	});
});
