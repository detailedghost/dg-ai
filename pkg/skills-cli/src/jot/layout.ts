export const CAP_BYTES = 2048;
export const INDEX_FILE = "00-index.md";

export interface JotPart {
	file: string;
	heading: string;
	body: string;
}

export type JotLayout =
	| { single: string }
	| { index: string; parts: JotPart[] };

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function slugify(heading: string): string {
	return (
		heading
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "part"
	);
}

export function titleOf(body: string): string {
	const lines = body.split("\n").map((l) => l.trim());
	const h1 = lines.find((l) => l.startsWith("# "));
	const first = h1 ? h1.slice(2) : (lines.find((l) => l !== "") ?? "");
	return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

/** Splits a body into parts under the cap; throws when it cannot. */
export function layoutJot(body: string, cap = CAP_BYTES): JotLayout {
	const text = body.endsWith("\n") ? body : `${body}\n`;
	if (text.trim() === "") throw new Error("empty body; pipe the jot on stdin");
	if (byteLength(text) <= cap) return { single: text };

	const lines = text.split("\n");
	const firstSection = lines.findIndex((l) => l.startsWith("## "));
	if (firstSection === -1) {
		throw new Error(
			`body is ${byteLength(text)} B > ${cap} B with no "## " sections; shorten it or add sections`,
		);
	}

	const head = lines.slice(0, firstSection).join("\n").trimEnd();
	const sections: { heading: string; body: string }[] = [];
	for (const line of lines.slice(firstSection)) {
		const current = sections[sections.length - 1];
		if (line.startsWith("## "))
			sections.push({ heading: line.slice(3).trim(), body: `${line}\n` });
		else if (current) current.body += `${line}\n`;
	}

	const parts = sections.map((s, i) => {
		const partBody = `${s.body.trimEnd()}\n`;
		const size = byteLength(partBody);
		if (size > cap)
			throw new Error(
				`section "${s.heading}" is ${size} B > ${cap} B; shorten it`,
			);
		const nn = String(i + 1).padStart(2, "0");
		return {
			file: `${nn}-${slugify(s.heading)}.md`,
			heading: s.heading,
			body: partBody,
		};
	});

	const rows = parts.map(
		(p) => `- ${p.file.slice(0, 2)}  ${p.heading}  ${byteLength(p.body)} B`,
	);
	const index = `${head ? `${head}\n\n` : ""}${rows.join("\n")}\n`;
	if (byteLength(index) > cap)
		throw new Error(
			`index is ${byteLength(index)} B > ${cap} B; shorten the text above the first "## "`,
		);
	return { index, parts };
}
