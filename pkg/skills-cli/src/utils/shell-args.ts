export function buildArgs(
	strings: TemplateStringsArray,
	values: unknown[],
): string[] {
	const args: string[] = [];
	// `cur` is the token being assembled. `open` is true when `cur` holds a
	// partial token that must be glued to whatever comes next (the previous
	// chunk did not end on whitespace), false when there's nothing pending.
	let cur = "";
	let open = false;

	const push = () => {
		if (open) {
			args.push(cur);
			cur = "";
			open = false;
		}
	};

	// Append literal template text, splitting on whitespace. The first token
	// glues to any pending `cur`; the last token stays open only if the text
	// did not end on whitespace (so a following value can glue onto it).
	const addLiteral = (seg: string) => {
		if (seg === "") return;
		const startsWS = /^\s/.test(seg);
		const endsWS = /\s$/.test(seg);
		const trimmed = seg.trim();

		if (startsWS) push();

		if (trimmed === "") {
			// Whitespace-only segment: closes any pending token.
			push();
			return;
		}

		const parts = trimmed.split(/\s+/);
		// First part glues onto a pending token; rest are standalone.
		cur += parts[0];
		open = true;
		for (let j = 1; j < parts.length; j++) {
			push();
			cur = parts[j];
			open = true;
		}
		if (endsWS) push();
	};

	// Append an interpolated value. A non-array value glues onto the current
	// token (its spaces/globs/newlines are never split); arrays expand to
	// standalone args; nullish and empty values are skipped.
	const addValue = (v: unknown) => {
		if (Array.isArray(v)) {
			push();
			args.push(...v.map((x) => String(x)));
			return;
		}
		if (v === undefined || v === null) return;
		const s = String(v);
		if (s.length === 0) return;
		cur += s;
		open = true;
	};

	for (let i = 0; i < strings.length; i++) {
		addLiteral(strings[i]);
		if (i < values.length) addValue(values[i]);
	}
	push();
	return args;
}
