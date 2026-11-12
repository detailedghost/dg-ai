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
