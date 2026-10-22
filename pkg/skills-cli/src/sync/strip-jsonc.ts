/** Strip `//` comments from a JSONC document, respecting string literals. */

/** Collect leading `//` comment lines (the JSONC header) and the remaining body lines. */
function splitHeader(text: string): { header: string[]; body: string[] } {
	const lines = text.split("\n");
	const header: string[] = [];
	let bodyStart = 0;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*\/\//.test(lines[i])) {
			header.push(lines[i]);
			bodyStart = i + 1;
		} else {
			break;
		}
	}
	return { header, body: lines.slice(bodyStart) };
}

/** Strip an inline `//` comment from a single line, respecting string literals. */
function stripInlineComment(line: string): string {
	let inString = false;
	let i = 0;
	while (i < line.length) {
		const c = line[i];
		if (inString) {
			if (c === "\\") {
				i += 2;
				continue;
			} else if (c === '"') {
				inString = false;
			}
		} else {
			if (c === '"') {
				inString = true;
			} else if (c === "/" && line[i + 1] === "/") {
				return line.slice(0, i).trimEnd();
			}
		}
		i++;
	}
	return line;
}

export interface StrippedJsonc {
	header: string;
	body: string;
}

/** Strip JSONC comments from `text`; `header` holds the leading `//` lines, if any. */
export function stripJsonc(text: string): StrippedJsonc {
	const { header, body } = splitHeader(text);
	return {
		header: header.join("\n"),
		body: body.map(stripInlineComment).join("\n"),
	};
}
