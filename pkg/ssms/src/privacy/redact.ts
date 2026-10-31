const PHONE = /\+\d[\d\s().-]{6,}\d/g;
const LINK_URI = /sgnl:\/\/\S+/gi;
const PUB_KEY = /pub_key=[^\s&"]+/gi;

export function redactSecrets(text: string): string {
	return text
		.replace(LINK_URI, "[link]")
		.replace(PUB_KEY, "pub_key=[redacted]")
		.replace(PHONE, "[phone]");
}

export function containsSecret(text: string): boolean {
	return redactSecrets(text) !== text;
}
