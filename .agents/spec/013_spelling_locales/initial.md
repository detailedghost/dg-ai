# Spelling hook locales beyond en-US and en-GB — Initial Notes

## Purpose
The opt-in spelling hook from spec 011_opt_in_hooks ships with one setting, en-US (default) or en-GB, backed by one British/American word-pair table read in either direction. This parked bundle extends it to more English variants (for example en-CA, en-AU) and possibly other languages, without slowing the hook past its 40 ms budget.

## Scope
### Included
- Per-locale word-pair files that the spelling hook loads by the locale setting in the dg config file
- The locale setting accepts every shipped locale; an unknown locale fails `dg-skills hooks set` with the list of valid values
- doctor reports the active locale and whether its word list loads
### Excluded
- Typo detection or a full dictionary engine (decide during the interview when this bundle is picked up)
- Changes to the en-US and en-GB behavior shipped by 011_opt_in_hooks
