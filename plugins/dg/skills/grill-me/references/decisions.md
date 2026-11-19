# ADRs — Three-Gate Test

At convergence, walk every `[DECIDED]` item in the decision log. Write a record only when ALL three gates pass. The full test is in `/dg:adr` [three-gates.md](../../adr/references/three-gates.md).

If any gate fails: skip. The Final Summary already captures it.

Every record passes through `/dg:adr new`. It writes the human ADR and the agent decision as a pair and runs the lint.
