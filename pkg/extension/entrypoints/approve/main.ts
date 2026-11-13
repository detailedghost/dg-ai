import { APPROVAL_MSG, type ApprovalRequest } from "@/lib/background/approval";
import "../options/style.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const id = new URLSearchParams(location.search).get("id") ?? "";

async function answer(allow: boolean): Promise<void> {
	const remember = $<HTMLInputElement>("remember").checked;
	await browser.runtime.sendMessage({ type: APPROVAL_MSG.answer, id, allow, remember });
	window.close();
}

async function show(): Promise<void> {
	const request = (await browser.runtime.sendMessage({ type: APPROVAL_MSG.get, id })) as
		| ApprovalRequest
		| undefined;
	if (!request) {
		$("gone").hidden = false;
		return;
	}
	$("title").textContent = request.title;
	$("origin").textContent = request.origin;
	const list = $("lines");
	for (const line of request.lines) {
		const item = document.createElement("li");
		item.textContent = line;
		list.append(item);
	}
	if (request.remember !== undefined) {
		$("remember-label").textContent = request.remember;
		$("remember-row").hidden = false;
	}
	$("actions").hidden = false;
	$<HTMLButtonElement>("allow").addEventListener("click", () => void answer(true));
	$<HTMLButtonElement>("deny").addEventListener("click", () => void answer(false));
}

void show();
