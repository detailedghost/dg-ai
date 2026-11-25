# Jobs skill details

Detail for the jobs skill. The rules in `SKILL.md` still apply: run each verb only on a request from the human that names the target.

## service

`service add` also takes `--autostart`, `--env-file <path>`, `--pass-env <NAME>`, `--stop-timeout <duration>` and `--grant <prefix>`. Pass one only when the human names it. `service add` and `service rm` edit the daemon config and work with no daemon running.

## daemon

`dg daemon start` is idempotent. It starts the daemon in the background, or reports the one that runs. A regular stop waits for the `stopTimeoutMs` of each service. `--force` skips that wait. A `restart` starts only the `autostart` services.

## job

`job add` also takes `--timeout <duration>`, `--notify <identity>`, `--env-file <path>`, `--env <NAME>` and `--stop-timeout <duration>`. Pass one only when the human names it. `job update` takes one mode flag (`--continuous`, `--schedule` or `--every`) and `--timeout`, `--feed` and `--notify`.
