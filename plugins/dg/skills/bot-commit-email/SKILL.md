---
name: bot-commit-email
description: Use dante+<botname>@detailedghost.com for GitLab and GitHub commits and reviews. Use when a bot commits, amends, or submits a review.
---

# Skill: bot-commit-email

Every bot must use `dante+<botname>@detailedghost.com` for GitLab and GitHub commits and review submissions.
`<botname>` is the lowercase bot display name, or its stable short slug.

Examples: `dante+warren@detailedghost.com` for Warren, `dante+baron@detailedghost.com` for Baron.

Do not use bare `dante@detailedghost.com`, a personal Gmail address, or another bot's plus tag.

## Apply

Set both the author email and the committer email to this bot's plus-address before every commit.
The name can be the bot's display name or the existing git identity.

```bash
export GIT_AUTHOR_EMAIL='dante+<botname>@detailedghost.com'
export GIT_COMMITTER_EMAIL='dante+<botname>@detailedghost.com'
```

Submit the GitLab or GitHub review from the account registered to that same plus-address. Before you push, confirm both addresses on the commit:

```bash
git log -1 --format='%ae %ce'
```
