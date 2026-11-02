/** Observed Proton headers are private page-memory state and must never enter relay responses. */
export type ProtonSessionHeaders = {
	uid: string;
	appVersion?: string;
	locale?: string;
};

/** Accepts only the two supported HTTPS Proton Mail origins, without subdomain or suffix matching. */
export function isProtonMailOrigin(origin: string): boolean {
	return (
		origin === "https://mail.proton.me" ||
		origin === "https://mail.protonmail.com"
	);
}
