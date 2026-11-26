# Browser finder

`pw open` uses `DG_BROWSER` (a browser binary path; `DG_VERIFY_BROWSER` is an alias) when set, then a system Chrome, then Edge, then another Chromium-family browser on PATH or in the usual app folders (Brave, Chromium, Vivaldi), then a Chromium that `install-browser` downloaded.
`--browser=chromium` uses the same list without the Chrome and Edge channels. `--browser=chrome` or `msedge` falls back to the full list when that browser is missing, and prints `chrome not found, using <path>`. With none, it exits 3 and prints every location it tried.
Ask the human before you run `dg pw install-browser`: it downloads about 150 MB under the dg data directory. Tell the human that `install-browser --remove` deletes the download.

