#!/bin/sh
root={{ROOT}}
exec "$root/runtime/current/bun" "$root/lib/current/dg.js" {{NAME}} "$@"
