#!/bin/sh
exec "{{ROOT}}/runtime/current/bun" "{{ROOT}}/lib/current/dg.js" {{NAME}} "$@"
