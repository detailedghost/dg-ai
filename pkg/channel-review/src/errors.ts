export const ERROR_CATALOG = {
	"CR-101":
		"I couldn't find a pull request link in your message, so I didn't review anything. Add the PR link and try again.",
	"CR-102":
		"The ~spice level must be a whole number from 1 to 5, so I didn't review this. Fix the number and try again.",
	"CR-103":
		"I don't know that ~agent. Pick claude, codex, copilot, or grok and try again.",
	"CR-104":
		"That link is not on a GitHub or GitLab server I review, so I didn't review it.",
	"CR-105":
		"Send $address and $review in separate messages, so I didn't run anything. Pick one and try again.",
	"CR-106": "Only {owner} can run $address, so I didn't run anything.",
	"CR-107": "Only {owner} can run $emoji, so I didn't change anything.",
	"CR-108":
		"The ~model flag needs a model name made of letters, numbers, dots, underscores, colons, slashes, or hyphens. Fix the name and try again.",
	"CR-109":
		"The ~effort level must be low, medium, high, xhigh, or max, so I didn't review this. Fix the level and try again.",
	"CR-201":
		"I couldn't start {agent} on {owner}'s computer, so I didn't review this. Try ~agent claude.",
	"CR-202":
		"{agent} is not signed in on {owner}'s computer, so I didn't review this. Ask {owner} to sign in, or try ~agent claude.",
	"CR-203":
		"{agent} stopped with an error before it finished, so the review is not complete. Try again, or try a different ~agent.",
	"CR-204":
		"The review took longer than {minutes} minutes, so I stopped it. Try again with a lower ~spice.",
	"CR-205":
		"The service stopped before the job finished. If you sent a request, post it again to restart it.",
	"CR-206":
		"The thrash skill is not installed for {agent} on {owner}'s computer, so I didn't review this. Ask {owner} to install it, or try a different ~agent.",
	"CR-207":
		"{agent} reached its usage or token limit, so the task is not complete. Try a different ~model or ~agent, or wait for the limit to reset.",
	"CR-208":
		"The AWS SSO sign-in for Bedrock expired on {owner}'s computer, so I started a new sign-in there. {owner} must approve it in the browser, then post the request again.",
	"CR-209":
		"The Bedrock call for {agent} failed before it finished — throttled, access denied, or the model is not available in {owner}'s account — so the task is not complete. Check the Bedrock setup, then try again.",
	"CR-301":
		"The review finished, but I found no review on the pull request. Check the PR, or post the request again.",
	"CR-302":
		"I couldn't open that pull request. Check that the link is right and that {owner} can see it.",
	"CR-303":
		"The GitHub or GitLab tool for this link is missing or not signed in on {owner}'s computer. Ask {owner} to sign in, then try again.",
	"CR-304":
		"I couldn't read which pull requests are stacked on this one, so I didn't review anything. Try again without ~stacked.",
	"CR-305":
		"That pull request comes from a fork, and I can't push to a fork, so I didn't address it.",
	"CR-306":
		"I couldn't clone the pull request branch on {owner}'s computer, so I didn't address it. Check that the branch still exists, then try again.",
	"CR-401":
		"I found no allowed repository for this error, so I didn't try a fix. Ask {owner} to add the service under errorWatch.repos.",
	"CR-402":
		"The hourly limit for automatic fixes is reached, so this fix waits. I try again on the next poll.",
	"CR-403":
		"A fix pull request for this error is already open, so I didn't start another.",
	"CR-404":
		"The fix agent changed nothing, so I opened no pull request. Check this error by hand.",
	"CR-405":
		"A git or GitHub step failed on {owner}'s computer, so I opened no pull request. Check that git and gh are signed in there.",
} satisfies Record<string, string>;

export type CrCode = keyof typeof ERROR_CATALOG;

export function replyText(
	code: CrCode,
	vars: { agent?: string; minutes?: number; owner?: string } = {},
): string {
	const sentence = ERROR_CATALOG[code]
		.replaceAll("{agent}", vars.agent ?? "the agent")
		.replaceAll("{minutes}", String(vars.minutes ?? ""))
		.replaceAll("{owner}", vars.owner ?? "the owner");
	return `${code}: ${sentence}`;
}

/** Display name for the {owner} placeholder, taken from the owner token (!owner -> Owner). */
export function ownerName(token: string): string {
	const name = token.replace(/^[^\p{L}\p{N}]+/u, "");
	return name ? name[0].toUpperCase() + name.slice(1) : "the owner";
}
