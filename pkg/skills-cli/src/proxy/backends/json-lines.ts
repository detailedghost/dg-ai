/** Parse JSON object lines, skipping blank lines, malformed lines, and non-object values. */
export function parseJsonLines(stdout: string): Array<Record<string, any>> {
	const events: Array<Record<string, any>> = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (typeof event === "object" && event !== null) events.push(event);
		} catch {}
	}
	return events;
}
