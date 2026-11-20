/** Single-quote a value for `eval` only when it holds characters the shell would split or expand. */
export function shellValue(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", "'\\''")}'`;
}
