import { createHash } from "node:crypto";

export function hashId(value: string, prefix = "m_hash"): string {
	const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
	return `${prefix}_${digest}`;
}
