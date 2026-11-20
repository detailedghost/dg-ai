import { isRecord } from "@dg/common";

/** Buffers the body, abandoning it the moment it passes the cap; undefined means it did. */
export async function readCappedBody(
	req: Request,
	capBytes: number,
): Promise<Buffer | undefined> {
	if (!req.body) return Buffer.alloc(0);
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > capBytes) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

export const STORAGE_FAILED =
	"Credential storage failed; check daemon health and encryption key access.";

export const HARDENING_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};

export function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...HARDENING_HEADERS, "Content-Type": "application/json" },
	});
}

export const refuse = (error: string, status: number) =>
	json({ ok: false, error }, status);

export function isJsonContentType(req: Request): boolean {
	const type = (req.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	return type === "application/json";
}

export async function readJsonObject(
	req: Request,
	capBytes: number,
): Promise<Record<string, unknown> | "too-large" | undefined> {
	const bytes = await readCappedBody(req, capBytes);
	if (!bytes) return "too-large";
	try {
		const parsed: unknown = JSON.parse(bytes.toString("utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
