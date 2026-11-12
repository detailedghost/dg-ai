# Attach a demo video to a PR

Only when the human passes `--attach-pr <pr>` or asks for it. After
`dg-skills demo status <slug>` prints the video path:

1. Run `dg-skills doctor pw`. If the `extension-paired` line is ok, use the
   human's browser:
   - `dg-skills pw --ext open <PR URL>`
   - `dg-skills pw --ext upload "<selector>" <video path>`, with a selector that
     matches only the file input of the new comment box.

   Each call opens an approval in the browser. The approval shows the file and
   the element. The human reviews the comment text and clicks Comment. Never
   submit the comment yourself.
2. If the extension is not paired, a step is denied or fails, or the PR is on
   GitLab, give the human the file paths and the PR link. Change nothing on the
   PR.
