/**
 * Status-renderer seam: slice 3 contributes its real describeKeySource() here
 * via setKeySourceProvider so it never has to edit slice 2's merged files.
 */
export type KeySourceProvider = () => string;

let provider: KeySourceProvider = () =>
	"unavailable (pre-slice-3: no key store yet)";

export function setKeySourceProvider(next: KeySourceProvider): void {
	provider = next;
}

export function describeKeySource(): string {
	return provider();
}
