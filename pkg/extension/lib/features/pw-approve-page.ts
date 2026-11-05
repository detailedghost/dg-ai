import type { PwExtApprovalPrompt } from "@/lib/background/pw-ext";
import type { PwExtApprovalPort } from "@/lib/background/pw-ext-approval";

/** Wires the approval page to its port; all prompt text renders as text nodes. */
export function mountPwApprove(
	doc: Document,
	port: Pick<PwExtApprovalPort, "postMessage" | "onMessage">,
	nonce: string,
): void {
	const root = doc.body;
	const heading = doc.createElement("h1");
	heading.textContent = "Waiting for the request…";
	const facts = doc.createElement("dl");
	const actions = doc.createElement("div");
	actions.hidden = true;
	const approve = doc.createElement("button");
	approve.id = "approve";
	approve.textContent = "Allow once";
	const deny = doc.createElement("button");
	deny.id = "deny";
	deny.textContent = "Deny";
	actions.append(approve, deny);
	root.append(heading, facts, actions);

	const answer = (approved: boolean) => {
		actions.hidden = true;
		port.postMessage({ type: "answer", nonce, approved });
	};
	approve.addEventListener("click", () => answer(true));
	deny.addEventListener("click", () => answer(false));

	port.onMessage.addListener((message) => {
		const value = message as { type?: string; prompt?: PwExtApprovalPrompt };
		if (value?.type !== "prompt" || !value.prompt) return;
		const prompt = value.prompt;
		heading.textContent = prompt.write
			? `An agent wants to change this page: ${prompt.verb}`
			: `An agent wants to read this page: ${prompt.verb}`;
		facts.replaceChildren();
		for (const [term, detail] of [
			["Tab", prompt.tabTitle],
			["URL", prompt.tabUrl],
			["Action", prompt.detail ?? ""],
		]) {
			if (!detail) continue;
			const dt = doc.createElement("dt");
			dt.textContent = term as string;
			const dd = doc.createElement("dd");
			dd.textContent = detail as string;
			facts.append(dt, dd);
		}
		actions.hidden = false;
	});
	port.postMessage({ type: "hello", nonce });
}
