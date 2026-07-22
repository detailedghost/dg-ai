import {
	type ColorSetting,
	DEFAULTS,
	getConfig,
	NARRATION_MODES,
	type NarrationMode,
	setConfig,
	VOICES,
} from "@/lib/config";
import { loadKokoro } from "@/utils/kokoro";
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
		o.textContent = v;
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

async function load(): Promise<void> {
	const cfg = await getConfig();
	$<HTMLSelectElement>("color").value = cfg.color;
	populateNarration(cfg.narration || DEFAULTS.narration);
	populateVoices(cfg.voice || DEFAULTS.voice);
}

async function save(): Promise<void> {
	await setConfig({
		color:
			($<HTMLSelectElement>("color").value as ColorSetting) || DEFAULTS.color,
		voice: $<HTMLSelectElement>("voice").value || DEFAULTS.voice,
		narration:
			($<HTMLSelectElement>("narration").value as NarrationMode) ||
			DEFAULTS.narration,
	});
	const status = $<HTMLSpanElement>("status");
	status.textContent = "Saved ✓";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
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
		status.classList.add("err");
		status.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
		console.error("[dg-ai-extension] TTS test failed", e);
	} finally {
		btn.disabled = false;
	}
}

/** Decode the wav → AudioContext → MediaRecorder → webm blob; the exact mix path video mode uses. */
function recordToWebm(wav: Blob): Promise<Blob> {
	return (async () => {
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
	})();
}

function downloadTest(): void {
	if (!lastWebm) return;
	const a = document.createElement("a");
	a.href = URL.createObjectURL(lastWebm);
	a.download = "dg-demo-narration-test.webm";
	a.click();
}

$<HTMLButtonElement>("save").addEventListener("click", () => void save());
$<HTMLButtonElement>("testTts").addEventListener(
	"click",
	() => void testNarration(),
);
$<HTMLButtonElement>("ttsDownload").addEventListener("click", downloadTest);
void load();
