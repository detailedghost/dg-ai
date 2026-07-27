export function canonicalMailboxValue(value: unknown): string {
	const sort = (current: unknown): unknown => {
		if (Array.isArray(current)) return current.map(sort);
		if (current !== null && typeof current === "object") {
			return Object.fromEntries(
				Object.keys(current)
					.sort()
					.map((key) => [
						key,
						sort((current as Record<string, unknown>)[key]),
					]),
			);
		}
		return Object.is(current, -0) ? 0 : current;
	};
	return JSON.stringify(sort(value));
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
