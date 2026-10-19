/** Split literal whitespace, keep each interpolated scalar in one token, expand arrays, and omit null, undefined and empty values. */
export function buildArgs(
	strings: TemplateStringsArray,
	values: unknown[],
): string[] {
	const args: string[] = [];
	let cur = "";
	let open = false;

	const push = () => {
		if (open) {
			args.push(cur);
			cur = "";
			open = false;
		}
	};

	const addLiteral = (seg: string) => {
		if (seg === "") return;
		const startsWS = /^\s/.test(seg);
		const endsWS = /\s$/.test(seg);
		const trimmed = seg.trim();

		if (startsWS) push();

		if (trimmed === "") {
			push();
			return;
		}

		const parts = trimmed.split(/\s+/);
		cur += parts[0];
		open = true;
		for (let j = 1; j < parts.length; j++) {
			push();
			cur = parts[j];
			open = true;
		}
		if (endsWS) push();
	};

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
