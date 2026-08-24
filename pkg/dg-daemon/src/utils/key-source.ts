export type KeySourceProvider = () => string;
export type UserVersionProvider = () => number;

let provider: KeySourceProvider = () => "unavailable (no key store open)";
let userVersionProvider: UserVersionProvider = () => 0;

export function setKeySourceProvider(next: KeySourceProvider): void {
	provider = next;
}

export function describeKeySource(): string {
	return provider();
}

export function setUserVersionProvider(next: UserVersionProvider): void {
	userVersionProvider = next;
}

export function describeUserVersion(): number {
	return userVersionProvider();
}
