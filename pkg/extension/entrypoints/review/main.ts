/**
 * Review page for a finished demo recording.
 *
 * Its own extension page rather than an overlay in the tour tab, because the video is
 * stored as a Blob and only an extension-origin document can play the object URL for
 * one. Reading IndexedDB directly is the whole point: the bytes never travel through a
 * message, which is what used to cap capture quality.
 *
 * Both buttons hand the *recording's* tab id back to the background — this page's own
 * tab id means nothing to a recording keyed by the tab that was captured. Whatever the
 * user picks, control returns to that tour tab, since re-recording happens there.
 */

import { type DownloadResult, MSG } from "@/lib/demo-messages";
import { getRecording } from "@/utils/recording-db";
import "../options/style.css";

const $ = <T extends HTMLElement>(id: string) =>
	document.getElementById(id) as T;

const tabId = Number(new URLSearchParams(location.search).get("tab"));

// Held so the video keeps playing until the page hands control back, then released.
let objectUrl: string | null = null;

function unavailable(reason: string): void {
	const note = $<HTMLElement>("unavailable");
	note.textContent = reason;
	note.hidden = false;
}

function fail(message: string): void {
	const status = $<HTMLElement>("status");
	status.classList.add("err");
	status.textContent = message;
}

async function load(): Promise<void> {
	if (!Number.isInteger(tabId)) {
		unavailable("This review page was opened without a recording to show.");
		return;
	}
	try {
		const entry = await getRecording(tabId);
		if (!entry) {
			unavailable(
				"That recording is no longer available — it was already saved, discarded, or aged out.",
			);
			return;
		}
		$<HTMLElement>("slug").textContent = entry.slug;
		objectUrl = URL.createObjectURL(entry.blob);
		const video = $<HTMLVideoElement>("video");
		video.src = objectUrl;
		video.hidden = false;
		$<HTMLElement>("actions").hidden = false;
	} catch (e) {
		console.error("[dg-ai-extension] could not read the recording", e);
		unavailable("The stored recording could not be read.");
	}
}

/**
 * Hand control back to the tour tab and get out of the way.
 *
 * Without this a discard strands the user on a dead review tab while the prompt to
 * record again is sitting on a tab they have to go find.
 */
async function handBack(): Promise<void> {
	if (objectUrl) URL.revokeObjectURL(objectUrl);
	try {
		await chrome.tabs.update(tabId, { active: true });
	} catch {
		// Tour tab already closed — still close this one rather than stall here.
	}
	const self = await chrome.tabs.getCurrent();
	if (self?.id != null) await chrome.tabs.remove(self.id);
}

function busy(on: boolean): void {
	$<HTMLButtonElement>("download").disabled = on;
	$<HTMLButtonElement>("discard").disabled = on;
}

async function download(): Promise<void> {
	busy(true);
	$<HTMLElement>("status").classList.remove("err");
	$<HTMLElement>("status").textContent = "Saving…";
	try {
		const res = (await chrome.runtime.sendMessage({
			type: MSG.videoConfirmDownload,
			tabId,
		})) as DownloadResult | undefined;
		if (res?.ok) {
			await handBack();
			return;
		}
		// Stay open on failure: the recording is deliberately kept so this can be retried.
		fail(`${res?.error ?? "the download did not start"} — try again.`);
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e));
	} finally {
		busy(false);
	}
}

async function discard(): Promise<void> {
	busy(true);
	try {
		await chrome.runtime.sendMessage({ type: MSG.videoDiscard, tabId });
	} catch (e) {
		// The tour tab re-arms off the background's message; nothing to salvage here.
		console.warn("[dg-ai-extension] discard was not acknowledged", e);
	}
	await handBack();
}

$<HTMLButtonElement>("download").addEventListener(
	"click",
	() => void download(),
);
$<HTMLButtonElement>("discard").addEventListener("click", () => void discard());

void load();
