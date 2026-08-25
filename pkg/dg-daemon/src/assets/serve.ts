import { CHAT_MAX_ASSET_BYTES } from "@dg/common";
import { type DgPaths, tokensEqual } from "@dg/common/node";
import { AES_GCM_IV_BYTES, AES_GCM_TAG_BYTES } from "../crypto/constants";
import type { SessionRegistry } from "../session/registry";
import type { ChatStore } from "../store";
import { getConfiguredAssetDirectory } from "./config";
import { resolveAssetContentType } from "./content-type";
import {
	AssetMissingError,
	AssetPathUnsafeError,
	assertFlatSegment,
	openAssetFile,
} from "./safe-path";

export type ResolveAssetDeps = {
	paths: DgPaths;
	store: ChatStore;
	registry: SessionRegistry;
};

export type ResolveAssetInput = {
	sessionId: string;
	token: string;
	id: string;
};

export type AssetServeResult =
	| {
			status: "ok";
			bytes: Buffer;
			contentType: string;
			inline: boolean;
			filename: string;
	  }
	| { status: "unauthorized" }
	| { status: "session-closed" }
	| { status: "unknown" }
	| { status: "pruned" }
	| { status: "unsafe-path" }
	| { status: "missing-file" }
	| { status: "too-large" }
	| { status: "corrupt" };

const MAX_ENVELOPE_BYTES =
	AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES + CHAT_MAX_ASSET_BYTES;

export async function resolveAssetForServing(
	deps: ResolveAssetDeps,
	input: ResolveAssetInput,
): Promise<AssetServeResult> {
	const record = deps.registry.get(input.sessionId);
	if (!record || !tokensEqual(record.token, input.token)) {
		return { status: "unauthorized" };
	}

	try {
		assertFlatSegment(input.sessionId);
		const row = deps.store.getAsset(input.sessionId, input.id);
		if (!row) return { status: "unknown" };
		if (row.state !== "active") return { status: "pruned" };
		if (record.state !== "active") return { status: "session-closed" };

		const handle = await openAssetFile(
			getConfiguredAssetDirectory(deps.paths),
			input.sessionId,
			row.id,
		);
		let raw: Buffer;
		try {
			const stats = await handle.stat();
			if (!stats.isFile()) return { status: "unsafe-path" };
			if (stats.size > MAX_ENVELOPE_BYTES) return { status: "too-large" };
			if (stats.size < AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES) {
				return { status: "corrupt" };
			}
			raw = await handle.readFile();
		} finally {
			await handle.close();
		}

		const bytes = deps.store.decryptAssetBytes(input.sessionId, row.id, {
			iv: raw.subarray(0, AES_GCM_IV_BYTES),
			tag: raw.subarray(AES_GCM_IV_BYTES, AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES),
			ciphertext: raw.subarray(AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES),
		});
		if (bytes.byteLength > CHAT_MAX_ASSET_BYTES) {
			return { status: "too-large" };
		}

		const typeInfo = resolveAssetContentType(row.filename);
		return {
			status: "ok",
			bytes,
			contentType: typeInfo.contentType,
			inline: typeInfo.inline,
			filename: row.filename,
		};
	} catch (err) {
		if (err instanceof AssetMissingError) return { status: "missing-file" };
		if (err instanceof AssetPathUnsafeError) return { status: "unsafe-path" };
		return { status: "corrupt" };
	}
}
