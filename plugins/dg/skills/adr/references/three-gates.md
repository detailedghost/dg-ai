# Three-Gate Test

Write a record only when ALL three gates pass:

1. **Reversal cost.** Undoing the decision later takes meaningful effort, a data migration or breakage.
2. **Reader confusion.** A future engineer reading the code alone will not understand why it has this shape.
3. **Real trade-off.** Genuine alternatives existed and were weighed. The choice was not an obvious default.

If any gate fails, skip the record. The grill summary or the PR body already captures the call. A record for an obvious call is noise.

Pass? Go to [write-adr.md](write-adr.md).
