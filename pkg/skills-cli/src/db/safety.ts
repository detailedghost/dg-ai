const READ_ONLY_KEYWORDS = new Set([
	"SELECT",
	"SHOW",
	"DESCRIBE",
	"DESC",
]);

const SET_PRIVILEGE_TARGETS = new Set(["ROLE"]);

const WRITE_KEYWORDS = new Set([
	"INSERT",
	"UPDATE",
	"DELETE",
	"MERGE",
	"CREATE",
	"ALTER",
	"DROP",
	"TRUNCATE",
	"GRANT",
	"REVOKE",
	"COPY",
	"CALL",
	"BEGIN",
	"COMMIT",
	"ROLLBACK",
	"EXECUTE",
]);

export interface SafetyResult {
	allowed: boolean;
	reason?: string;
}

interface SqlToken {
	word: string;
	depth: number;
}

interface SqlScan {
	tokens: SqlToken[];
	statementCount: number;
}

function scanSql(sql: string): SqlScan {
	const tokens: SqlToken[] = [];
	let depth = 0;
	let statements = 0;
	let hasContent = false;
	let i = 0;

	const skipQuoted = (quote: string) => {
		hasContent = true;
		i++;
		while (i < sql.length) {
			if (sql[i] === quote) {
				if (sql[i + 1] === quote) {
					i += 2;
					continue;
				}
				i++;
				return;
			}
			i++;
		}
	};

	while (i < sql.length) {
		const char = sql[i] ?? "";
		const next = sql[i + 1] ?? "";
		if (/\s/.test(char)) {
			i++;
			continue;
		}
		if (char === "-" && next === "-") {
			i += 2;
			while (i < sql.length && sql[i] !== "\n") i++;
			continue;
		}
		if (char === "/" && next === "*") {
			i += 2;
			while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/"))
				i++;
			i = Math.min(sql.length, i + 2);
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			skipQuoted(char);
			continue;
		}
		if (char === "$") {
			const delimiter = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
			if (delimiter) {
				hasContent = true;
				const end = sql.indexOf(delimiter, i + delimiter.length);
				i = end === -1 ? sql.length : end + delimiter.length;
				continue;
			}
		}
		if (char === "(") {
			hasContent = true;
			depth++;
			i++;
			continue;
		}
		if (char === ")") {
			hasContent = true;
			depth = Math.max(0, depth - 1);
			i++;
			continue;
		}
		if (char === ";" && depth === 0) {
			if (hasContent) statements++;
			hasContent = false;
			i++;
			continue;
		}
		if (/[A-Za-z_]/.test(char)) {
			const start = i;
			i++;
			while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i] ?? "")) i++;
			tokens.push({ word: sql.slice(start, i).toUpperCase(), depth });
			hasContent = true;
			continue;
		}
		hasContent = true;
		i++;
	}

	if (hasContent) statements++;
	return { tokens, statementCount: statements };
}

function containsSelectInto(tokens: SqlToken[]): boolean {
	// Scope INTO to the outer statement so a nested subquery cannot redefine the top-level operation.
	let sawTopLevelSelect = false;
	for (const token of tokens) {
		if (token.depth !== 0) continue;
		if (token.word === "SELECT") sawTopLevelSelect = true;
		else if (sawTopLevelSelect && token.word === "INTO") return true;
	}
	return false;
}

function cteContainsDml(tokens: SqlToken[]): boolean {
	return tokens.slice(1).some((token) => WRITE_KEYWORDS.has(token.word));
}

export function classifySql(sql: string, writeEnabled: boolean): SafetyResult {
	if (writeEnabled) return { allowed: true };

	const scan = scanSql(sql);
	if (scan.statementCount > 1)
		return {
			allowed: false,
			reason: "multiple statements detected — use --write to allow",
		};

	const keyword = scan.tokens[0]?.word ?? "";
	if (!keyword)
		return { allowed: false, reason: "empty or unparseable SQL" };

	if (keyword === "EXPLAIN") {
		if (scan.tokens.some((token) => token.word === "ANALYZE"))
			return {
				allowed: false,
				reason: "EXPLAIN ANALYZE executes the query — use --write",
			};
		return { allowed: true };
	}

	if (keyword === "WITH") {
		if (cteContainsDml(scan.tokens))
			return {
				allowed: false,
				reason: "CTE contains write operations — use --write",
			};
		if (containsSelectInto(scan.tokens))
			return {
				allowed: false,
				reason: "SELECT INTO creates a table — use --write",
			};
		return { allowed: true };
	}

	if (keyword === "SELECT" && containsSelectInto(scan.tokens))
		return {
			allowed: false,
			reason: "SELECT INTO creates a table — use --write",
		};

	if (keyword === "SET") {
		const target = scan.tokens[1]?.word ?? "";
		const isSessionAuthorization =
			target === "SESSION" && scan.tokens[2]?.word === "AUTHORIZATION";
		if (SET_PRIVILEGE_TARGETS.has(target) || isSessionAuthorization)
			return {
				allowed: false,
				reason: "SET ROLE/SESSION AUTHORIZATION changes session privileges — use --write",
			};
		return { allowed: true };
	}

	if (READ_ONLY_KEYWORDS.has(keyword)) return { allowed: true };
	if (WRITE_KEYWORDS.has(keyword))
		return {
			allowed: false,
			reason: `${keyword} requires --write flag`,
		};

	return {
		allowed: false,
		reason: `unknown statement "${keyword}" — use --write to allow`,
	};
}
