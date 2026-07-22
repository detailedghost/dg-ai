#!/bin/sh
# Install the compiled dg-skills CLI for the current platform into ~/.dg/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
#
# Idempotent: re-running overwrites the binary with the newest skills-v* release.
# Windows: use bootstrap.ps1 instead.
set -eu

REPO="detailedghost/dg-ai"
BIN_DIR="${HOME}/.dg/bin"
DEST="${BIN_DIR}/dg-skills"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
Linux) osname="linux" ;;
Darwin) osname="macos" ;;
*)
  echo "dg-skills: unsupported OS '$os' — use bootstrap.ps1 on Windows" >&2
  exit 1
  ;;
esac
case "$arch" in
x86_64 | amd64) cpu="x64" ;;
aarch64 | arm64) cpu="arm64" ;;
*)
  echo "dg-skills: unsupported arch '$arch'" >&2
  exit 1
  ;;
esac
asset="dg-skills-${osname}-${cpu}"

# GitHub /releases is newest-first, so the first matching asset URL is the latest.
url=$(curl -fsSL -H "User-Agent: dg-ai" \
  "https://api.github.com/repos/${REPO}/releases?per_page=30" |
  grep -oE '"browser_download_url":[[:space:]]*"[^"]+"' |
  sed -E 's/.*"(https:[^"]+)".*/\1/' |
  grep -E "/${asset}$" |
  head -1)

if [ -z "${url}" ]; then
  echo "dg-skills: no ${asset} asset in latest skills-v* release" >&2
  exit 1
fi

mkdir -p "${BIN_DIR}"
curl -fsSL -H "User-Agent: dg-ai" -o "${DEST}" "${url}"
chmod +x "${DEST}"

# Stamp the installed version so `dg-skills install` won't re-download the binary.
version=$(echo "${url}" | sed -E 's#.*/download/skills-v([^/]+)/.*#\1#')
[ -n "${version}" ] && printf '%s\n' "${version}" >"${BIN_DIR}/.dg-skills.version"
echo "dg-skills installed at ${DEST}"

case ":${PATH}:" in
*":${BIN_DIR}:"*) ;;
*) echo "Add to PATH:  export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac

# Set up the browser extension too, so one command installs everything.
echo "Setting up the dg-ai-extension…"
"${DEST}" install
