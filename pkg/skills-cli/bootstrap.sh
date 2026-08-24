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

releases=$(curl -fsSL -H "User-Agent: dg-ai" \
  "https://api.github.com/repos/${REPO}/releases?per_page=30")

tag=$(printf '%s' "${releases}" |
  grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"skills-v[^"]*"' |
  head -1 |
  sed -E 's/.*"(skills-v[^"]*)".*/\1/')

if [ -z "${tag}" ]; then
  echo "dg-skills: no published skills-v* release found" >&2
  exit 1
fi

url=$(printf '%s' "${releases}" |
  grep -oE "https://[^\"]+/download/${tag}/${asset}" |
  head -1)

if [ -z "${url}" ]; then
  echo "dg-skills: no ${asset} asset in ${tag}" >&2
  exit 1
fi

mkdir -p "${BIN_DIR}"
curl -fsSL -H "User-Agent: dg-ai" -o "${DEST}" "${url}"
chmod +x "${DEST}"

# Stamp the installed version so `dg-skills install` won't re-download the binary.
version=${tag#skills-v}
[ -n "${version}" ] && printf '%s\n' "${version}" >"${BIN_DIR}/.dg-skills.version"
echo "dg-skills installed at ${DEST}"

case ":${PATH}:" in
*":${BIN_DIR}:"*) ;;
*) echo "Add to PATH:  export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac

# Set up the browser extension too, so one command installs everything.
echo "Setting up the dg-ai-extension…"
"${DEST}" install

# Optional Codex skill installation. Set DG_INSTALL_CODEX=1 to copy the
# repository's skills into CODEX_HOME (default: ~/.codex/skills).
if [ "${DG_INSTALL_CODEX:-0}" = "1" ]; then
  CODEX_ROOT="${CODEX_HOME:-${HOME}/.codex}"
  tmpdir=$(mktemp -d)
  trap 'rm -rf "${tmpdir}"' EXIT
  archive="${tmpdir}/dg-ai.tar.gz"
  curl -fsSL -H "User-Agent: dg-ai" \
    "https://github.com/${REPO}/archive/refs/heads/master.tar.gz" -o "${archive}"
  mkdir -p "${CODEX_ROOT}/skills"
  tar -xzf "${archive}" -C "${tmpdir}"
  cp -R "${tmpdir}/dg-ai-master/plugins/dg/skills/." "${CODEX_ROOT}/skills/"
  echo "Codex skills installed in ${CODEX_ROOT}/skills"
fi
