import { defineMiddleware } from "astro:middleware";

/**
 * Astro excludes any src/pages path segment prefixed with "_" from routing
 * (including nested API files), so the identity-probe route lives at
 * /api/meta on disk. This rewrite keeps /api/_meta reachable for callers/tests
 * that use the underscore path as the conventional "internal" marker.
 */
export const onRequest = defineMiddleware((context, next) => {
	if (context.url.pathname === "/api/_meta") {
		return context.rewrite(
			new Request(new URL("/api/meta", context.url), {
				headers: context.request.headers,
			}),
		);
	}
	return next();
});
