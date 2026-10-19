# GitHub API Reference

> **Human-only reference.** The runtime workflow uses `"$DG" address` for supported review operations and retains one native `gh` read for Wiz summary comments. Do not load this file during skill execution. It lets a maintainer compare the helper with the underlying API.

## Get Current PR

```sh
gh pr view --json number,headRefName,url
```

Extract owner/repo:

```sh
gh repo view --json owner,name --jq '"owner=" + .owner.login + " repo=" + .name'
```

## Fetch Review Threads + Comments (GraphQL)

Use GraphQL to get threads (with node IDs needed to resolve later):

```sh
gh api graphql -F owner='{owner}' -F repo='{repo}' -F pr=PR_NUMBER -f query='
query($owner:String!,$repo:String!,$pr:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          comments(first:50) {
            nodes { id databaseId body path line diffHunk author{login} }
          }
        }
      }
    }
  }
}'
```

This returns `reviewThreads.nodes[]` each with `.id` (thread ID for resolving) and `.comments.nodes[]`.

## Reply to a Comment

```sh
gh api "repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies" \
  --method POST -f body="summary text here"
```

`comment_id` = `databaseId` of the top-level comment in the thread (first comment, NOT a reply).

Use this REST endpoint for replies. Do not use GraphQL's `addPullRequestReviewThreadReply`: when several replies
are posted together, GitHub can attach them to unpublished pending reviews. Confirm the response's
`in_reply_to_id` equals `comment_id` before resolving the thread.

## Resolve a Thread

```sh
gh api graphql -f threadId='THREAD_NODE_ID' -f query='
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread { isResolved }
  }
}'
```

`threadId` = the `.id` field from `reviewThreads.nodes[]`.

## Notes

- Pagination: if >100 threads, use `after` cursor. Rare in practice.
- Reply target must be a top-level comment ID, not a reply-to-reply.
- `#ignore` filtering: check `body` of ALL comments in a thread (any user).
