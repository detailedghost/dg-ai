import type { Cookie } from "playwright-core";

export const formatCookie = (cookie: Cookie): string =>
	`${cookie.name}=${cookie.value} (domain: ${cookie.domain}, path: ${cookie.path})`;

export const formatCookieDetail = (cookie: Cookie): string =>
	`${cookie.name}=${cookie.value} (domain: ${cookie.domain}, path: ${cookie.path}, ` +
	`httpOnly: ${cookie.httpOnly}, secure: ${cookie.secure}, sameSite: ${cookie.sameSite}, expires: ${cookie.expires})`;
