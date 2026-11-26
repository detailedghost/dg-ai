import { SITE_ALLOW_MSG, type SiteAllowRequest } from "@/lib/background/site-allow-prompt";
import "../options/style.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const id = new URLSearchParams(location.search).get("id") ?? "";

async function answer(allow: boolean): Promise<void> {
	const phi = $<HTMLInputElement>("phi").checked;
	await browser.runtime.sendMessage({ type: SITE_ALLOW_MSG.answer, id, allow, phi });
	window.close();
}

async function show(): Promise<void> {
	const request = (await browser.runtime.sendMessage({ type: SITE_ALLOW_MSG.get, id })) as
		| SiteAllowRequest
		| undefined;
	if (!request) {
		$("gone").hidden = false;
		return;
	}
	$("site").textContent = request.siteKey;
	$("phi-row").hidden = false;
	$("actions").hidden = false;
	$<HTMLButtonElement>("allow").addEventListener("click", () => void answer(true));
	$<HTMLButtonElement>("deny").addEventListener("click", () => void answer(false));
}

void show();
