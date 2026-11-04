@echo off
setlocal DisableDelayedExpansion
"{{ROOT}}\runtime\current\bun.exe" "{{ROOT}}\lib\current\dg.js" {{NAME}} %*
