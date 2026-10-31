const PHONE =
	/(?:\+\d(?:[\s().-]*\d){6,}|\(\d{3}\)(?:[\s.-]*\d){7,}|\b1[\s.-]\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{7,}\b)/g;
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
