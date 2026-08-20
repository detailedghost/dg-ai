/** Fixed extension to content-type lookup, with a denylist for never-inline active content. */
import { extname } from "node:path";

export type AssetContentTypeInfo = { contentType: string; inline: boolean };

const INLINE_RASTER_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const ATTACHMENT_ONLY_TYPES: Record<string, string> = {
	".svg": "image/svg+xml",
	".html": "text/html",
	".htm": "text/html",
};

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

export function resolveAssetContentType(
	filename: string,
): AssetContentTypeInfo {
	const ext = extname(filename).toLowerCase();
	if (ext in INLINE_RASTER_TYPES) {
		return { contentType: INLINE_RASTER_TYPES[ext], inline: true };
	}
	if (ext in ATTACHMENT_ONLY_TYPES) {
		return { contentType: ATTACHMENT_ONLY_TYPES[ext], inline: false };
	}
	return { contentType: FALLBACK_CONTENT_TYPE, inline: false };
}

/** RFC 8187 extended value: encodeURIComponent leaves characters a `token` may not carry. */
function encodeExtendedValue(value: string): string {
	return encodeURIComponent(value).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/** RFC 6266: percent-encoding into `filename=` mangles the name for every client — the UTF-8 form belongs in `filename*`. */
export function assetContentDisposition(
	info: AssetContentTypeInfo,
	filename: string,
): string {
	if (info.inline) return "inline";
	const ascii = filename
		.replace(/[^\x20-\x7e]/g, "_")
		.replace(/["\\]/g, "_")
		.trim();
	const fallback = ascii.length > 0 ? ascii : "asset";
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeExtendedValue(filename)}`;
}
