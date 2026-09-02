import {
	getVideoQuality,
	QUALITY_PRESETS,
	VIDEO_QUALITIES,
	type VideoQuality,
} from "@/lib/capture-quality";
import {
	type ColorSetting,
	createLiveAssetDirectoryTransport,
	DEFAULTS,
	getConfig,
	getNarrationMode,
	NARRATION_MODES,
	type NarrationMode,
	getTheme,
	patchConfig,
	type ThemeSetting,
	THEMES,
	VOICES,
	voiceLabel,
} from "@/lib/config";
import { PAGES, type PageId, resolvePage } from "@/lib/options-nav";
import { failStatus, flashStatus } from "@/lib/ui-helpers";
import { loadKokoro } from "@/utils/kokoro";
import { mountAssetDirectoryPanel } from "./asset-directory";
import "./style.css";

const $ = <T extends HTMLElement>(id: string) =>
	document.getElementById(id) as T;

// Last generated test clip, offered via the Download button after generation.
let lastWebm: Blob | null = null;

function populateVoices(selected: string): void {
	const sel = $<HTMLSelectElement>("voice");
	for (const v of VOICES) {
		const o = document.createElement("option");
		o.value = v;
		o.textContent = voiceLabel(v);
		sel.appendChild(o);
	}
	sel.value = selected;
}

function populateNarration(selected: NarrationMode): void {
	const sel = $<HTMLSelectElement>("narration");
	for (const m of NARRATION_MODES) {
		const o = document.createElement("option");
		o.value = m.value;
		o.textContent = m.label;
		sel.appendChild(o);
	}
	sel.value = selected;
}

function populateQuality(selected: VideoQuality): void {
	const sel = $<HTMLSelectElement>("videoQuality");
	for (const q of VIDEO_QUALITIES) {
		const o = document.createElement("option");
		o.value = q;
		o.textContent = QUALITY_PRESETS[q].label;
		sel.appendChild(o);
	}
	sel.value = selected;
}

function fail(status: HTMLElement, prefix: string, e: unknown): void {
	failStatus(
		status,
		`${prefix}: ${e instanceof Error ? e.message : String(e)}`,
	);
	console.error(`[dg-ai-extension] ${prefix}`, e);
}

/** Paint a theme and label the button with the one it switches to. */
function applyTheme(theme: ThemeSetting): void {
	document.documentElement.dataset.theme = theme;
	const other = THEMES.find((t) => t.value !== theme);
	$<HTMLButtonElement>("theme").textContent = other?.label ?? "Light";
}

async function load(): Promise<void> {
	try {
		const cfg = await getConfig();
		$<HTMLSelectElement>("color").value = cfg.color;
		populateNarration(getNarrationMode(cfg.narration));
		populateVoices(cfg.voice || DEFAULTS.voice);
		populateQuality(getVideoQuality(cfg.videoQuality));
		applyTheme(getTheme(cfg.theme));
	} catch (e) {
		// Surfaced rather than swallowed: empty dropdowns are the visible symptom.
		fail($<HTMLElement>("status"), "Could not read saved settings", e);
	}
}

/**
 * Persist every control, reporting into the status line next to the one that
 * changed.
 *
 * Autosave rather than a Save button: the single button used to live inside the
 * narration panel, so the Tab grouping panel above it had no save path at all —
 * group color silently never persisted, and the unsaved "random" default made it
 * look like the setting was being ignored.
 */
async function persist(statusId: string): Promise<void> {
	const status = $<HTMLElement>(statusId);
	try {
		await patchConfig({
			color:
				($<HTMLSelectElement>("color").value as ColorSetting) || DEFAULTS.color,
			voice: $<HTMLSelectElement>("voice").value || DEFAULTS.voice,
			narration: getNarrationMode($<HTMLSelectElement>("narration").value),
			videoQuality: getVideoQuality($<HTMLSelectElement>("videoQuality").value),
		});
		flashStatus(status, "Saved ✓");
	} catch (e) {
		fail(status, "Save failed", e);
	}
}

function showPage(id: PageId): void {
	for (const p of PAGES) {
		$<HTMLElement>(`page-${p}`).hidden = p !== id;
		const link = document.querySelector(`[data-nav="${p}"]`);
		if (!link) continue;
		if (p === id) link.setAttribute("aria-current", "page");
		else link.removeAttribute("aria-current");
	}
}

/** Spike: prove Kokoro loads, generates, and can be mixed→recorded→downloaded here. */
async function testNarration(): Promise<void> {
	const btn = $<HTMLButtonElement>("testTts");
	const status = $<HTMLSpanElement>("ttsStatus");
	const voice = $<HTMLSelectElement>("voice").value || DEFAULTS.voice;
	btn.disabled = true;
	status.classList.remove("err");
	try {
		status.textContent = "Loading model (~86MB, first run only)…";
		const tts = await loadKokoro();
		status.textContent = "Generating…";
		// Voice is a literal union in kokoro-js; our value is validated at the UI.
		const audio = await tts.generate(
			"Hi! This is the DeeGee demo narration voice.",
			{ voice: voice as never },
		);
		const wav = audio.toBlob();
		$<HTMLAudioElement>("ttsAudio").src = URL.createObjectURL(wav);
		lastWebm = await recordToWebm(wav);
		$<HTMLButtonElement>("ttsDownload").hidden = false;
		status.textContent = "Done ✓ — preview above, or download the .webm";
	} catch (e) {
		fail(status, "Failed", e);
	} finally {
		btn.disabled = false;
	}
}

/** Decode the wav → AudioContext → MediaRecorder → webm blob; the exact mix path video mode uses. */
async function recordToWebm(wav: Blob): Promise<Blob> {
	const ctx = new AudioContext();
	const buf = await ctx.decodeAudioData(await wav.arrayBuffer());
	const dest = ctx.createMediaStreamDestination();
	const src = ctx.createBufferSource();
	src.buffer = buf;
	src.connect(dest);
	const rec = new MediaRecorder(dest.stream, { mimeType: "audio/webm" });
	const chunks: Blob[] = [];
	rec.ondataavailable = (e) => {
		if (e.data.size) chunks.push(e.data);
	};
	return await new Promise<Blob>((resolve) => {
		rec.onstop = () => {
			void ctx.close();
			resolve(new Blob(chunks, { type: "audio/webm" }));
		};
		rec.start();
		src.start();
		src.onended = () => rec.stop();
	});
}

function downloadTest(): void {
	if (!lastWebm) return;
	const a = document.createElement("a");
	a.href = URL.createObjectURL(lastWebm);
	a.download = "dg-demo-narration-test.webm";
	a.click();
}

$<HTMLSelectElement>("color").addEventListener(
	"change",
	() => void persist("colorStatus"),
);
for (const id of ["narration", "voice", "videoQuality"]) {
	$<HTMLSelectElement>(id).addEventListener(
		"change",
		() => void persist("status"),
	);
}
$<HTMLButtonElement>("testTts").addEventListener(
	"click",
	() => void testNarration(),
);
$<HTMLButtonElement>("ttsDownload").addEventListener("click", downloadTest);
$<HTMLButtonElement>("theme").addEventListener("click", () => {
	const next: ThemeSetting =
		document.documentElement.dataset.theme === "light" ? "dark" : "light";
	applyTheme(next);
	void patchConfig({ theme: next });
});
window.addEventListener("hashchange", () =>
	showPage(resolvePage(window.location.hash)),
);

mountAssetDirectoryPanel($<HTMLElement>("assetDirectoryPanel"), {
	transport: createLiveAssetDirectoryTransport(),
});

showPage(resolvePage(window.location.hash));
void load();
