import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type Answer = { ok: boolean; value?: unknown; error?: string };

const url = process.env.DG_DAEMON_URL as string;
const prefix = process.env.DG_CREDENTIAL_GRANT_PREFIX as string;
const token = readFileSync(
	process.env.DG_CREDENTIAL_GRANT_FILE as string,
	"utf8",
).trim();

async function call(body: Record<string, unknown>): Promise<Answer> {
	const response = await fetch(`${url}/service-api/v1/credentials`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Dg-Grant-Prefix": prefix,
			"X-Dg-Grant-Token": token,
		},
		body: JSON.stringify(body),
	});
	return (await response.json()) as Answer;
}

const listed = await call({ operation: "list" });
const names = (listed.value as { name: string }[]).map((entry) => entry.name);
if (names.length === 0) {
	console.error("no credential below the prefix");
	process.exit(1);
}
const fetched = await call({ operation: "get", name: names[0] });
const value = (fetched.value as { value: string }).value;
console.log(
	JSON.stringify({
		names,
		name: names[0],
		sha256: createHash("sha256").update(value).digest("hex"),
	}),
);
process.exit(0);
