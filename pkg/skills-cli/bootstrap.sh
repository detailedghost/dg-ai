#!/bin/sh
# Install the compiled dg-skills CLI for the current platform into ~/.dg/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
#   ... | sh -s -- --cli-only   (or DG_CLI_ONLY=1): skip the extension, dg-daemon and dg-agent
#
# Idempotent: re-running overwrites the binary with the newest skills-v* release.
# Windows: use bootstrap.ps1 instead.
#
# Checksums: when the skills-v* release publishes a SHA256SUMS asset (GNU
# sha256sum lines, "<hash>  <filename>"), the download is verified before it
# is installed. Releases that do not include SHA256SUMS still install. The
# skills release workflow writes that file next to the platform binaries.
set -eu

CLI_ONLY="${DG_CLI_ONLY:-0}"
for arg in "$@"; do
  [ "${arg}" = "--cli-only" ] && CLI_ONLY=1
done

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

PER_PAGE=100
PAGE_CAP=10

releases=""
tag=""
page=1
while [ -z "${tag}" ] && [ "${page}" -le "${PAGE_CAP}" ]; do
  batch=$(curl -fsSL -H "User-Agent: dg-ai" \
    "https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}")
  releases="${releases}${batch}"
  tag=$(printf '%s' "${batch}" |
    grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"skills-v[^"]*"' |
    head -1 |
    sed -E 's/.*"(skills-v[^"]*)".*/\1/')
  batch_count=$(printf '%s' "${batch}" | grep -o '"tag_name"[[:space:]]*:' | wc -l)
  [ "${batch_count}" -lt "${PER_PAGE}" ] && break
  page=$((page + 1))
done

if [ -z "${tag}" ]; then
  scanned=$(printf '%s' "${releases}" | grep -o '"tag_name"[[:space:]]*:' | wc -l)
  echo "dg-skills: no skills-v* release found in the ${scanned} releases scanned" >&2
  exit 1
fi

url=$(printf '%s' "${releases}" |
  grep -oE "https://[^\"]+/download/${tag}/${asset}" |
  head -1)

if [ -z "${url}" ]; then
  echo "dg-skills: no ${asset} asset in ${tag}" >&2
  exit 1
fi

# Verify DEST against SHA256SUMS when that asset is on this same release.
# A missing checksum file is not an error: older skills-v* releases predate it.
verify_sha256() {
  sums_url=$(printf '%s' "${releases}" |
    grep -oE "https://[^\"]+/download/${tag}/SHA256SUMS" |
    head -1)
  if [ -z "${sums_url}" ]; then
    return 0
  fi
  sums_file=$(mktemp)
  if ! curl -fsSL -H "User-Agent: dg-ai" -o "${sums_file}" "${sums_url}"; then
    rm -f "${DEST}" "${sums_file}"
    echo "dg-skills: failed to download SHA256SUMS for ${tag}" >&2
    exit 1
  fi
  expected=$(awk -v asset="${asset}" '
    $1 ~ /^[0-9A-Fa-f]{64}$/ {
      name = $2
      sub(/^\*/, "", name)
      if (name == asset) { print $1; exit }
    }
  ' "${sums_file}" | tr 'A-F' 'a-f')
  if [ -z "${expected}" ]; then
    rm -f "${DEST}" "${sums_file}"
    echo "dg-skills: SHA256SUMS in ${tag} has no entry for ${asset}" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "${DEST}" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "${DEST}" | awk '{print $1}')
  else
    rm -f "${DEST}" "${sums_file}"
    echo "dg-skills: SHA256SUMS was published for ${tag} but sha256sum and shasum are missing" >&2
    exit 1
  fi
  actual=$(printf '%s' "${actual}" | tr 'A-F' 'a-f')
  rm -f "${sums_file}"
  if [ "${actual}" != "${expected}" ]; then
    rm -f "${DEST}"
    echo "dg-skills: checksum mismatch for ${asset} in ${tag}" >&2
    exit 1
  fi
}

# The binary this script just installed is current, so `dg-skills install`
# would otherwise say "already current" right after "installed".
run_install() {
  log=$(mktemp)
  set +e
  "$@" >"${log}" 2>&1
  status=$?
  set -e
  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in
      "dg-skills already current (v"*)
        ver=${line#"dg-skills already current (v"}
        ver=${ver%")."}
        echo "dg-skills verified (v${ver})."
        ;;
      *)
        printf '%s\n' "${line}"
        ;;
    esac
  done <"${log}"
  rm -f "${log}"
  return "${status}"
}

mkdir -p "${BIN_DIR}"
curl -fsSL -H "User-Agent: dg-ai" -o "${DEST}" "${url}"
verify_sha256
chmod +x "${DEST}"

# Stamp the installed version so `dg-skills install` won't re-download the binary.
version=${tag#skills-v}
[ -n "${version}" ] && printf '%s\n' "${version}" >"${BIN_DIR}/.dg-skills.version"
echo "dg-skills installed at ${DEST}"

case ":${PATH}:" in
*":${BIN_DIR}:"*) ;;
*) echo "Add to PATH:  export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac

if [ "${CLI_ONLY}" = "1" ]; then
  DG_SKILLS_BOOTSTRAP=1 run_install "${DEST}" install --cli-only
else
  # Set up the browser extension too, so one command installs everything.
  echo "Setting up the dg-ai-extension…"
  DG_SKILLS_BOOTSTRAP=1 run_install "${DEST}" install
fi

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
  for skill in "${tmpdir}/dg-ai-master/plugins/dg/skills"/*/; do
    if [ "${CLI_ONLY}" = "1" ] && grep -qE '^requires:.*extension' "${skill}SKILL.md"; then
      continue
    fi
    cp -R "${skill}" "${CODEX_ROOT}/skills/"
  done
  echo "Codex skills installed in ${CODEX_ROOT}/skills"
fi
