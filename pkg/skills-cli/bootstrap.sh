#!/bin/sh
# Install the compiled dg-skills CLI for the current platform into ~/.dg/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
#   ... | sh -s -- --cli-only   (or DG_CLI_ONLY=1): skip the extension, dg-daemon and dg-agent
#   ... | sh -s -- --skills-only (or DG_SKILLS_ONLY=1): copy skill instruction files only.
#       No release binaries are downloaded and no skill content is executed.
#
# Idempotent: re-running overwrites the binary with the newest skills-v* release.
# --skills-only instead copies plugins/dg/skills into $DG_SKILLS_DEST
# (default: $DG_HOME/skills or ~/.dg/skills).
# Windows: use bootstrap.ps1 instead.
#
# Checksums: when the skills-v* release publishes a SHA256SUMS asset (GNU
# sha256sum lines, "<hash>  <filename>"), the download is verified before it
# is installed. Releases that do not include SHA256SUMS still install. The
# skills release workflow writes that file next to the platform binaries.
set -eu

CLI_ONLY="${DG_CLI_ONLY:-0}"
SKILLS_ONLY="${DG_SKILLS_ONLY:-0}"
for arg in "$@"; do
  [ "${arg}" = "--cli-only" ] && CLI_ONLY=1
  [ "${arg}" = "--skills-only" ] && SKILLS_ONLY=1
done

# Copy skill directories as data. A skill is an immediate child that contains
# SKILL.md. The same rule lives in @dg/common filesToInstall. Symlinks are
# refused. Files are written mode 0644 and never executed.
copy_skill_tree() {
  src=$1
  dest=$2
  manifest=$(mktemp)
  if [ ! -d "$src" ]; then
    echo "dg-skills: no skills directory at ${src}" >&2
    exit 1
  fi
  if find "$src" -type l | grep -q .; then
    echo "dg-skills: refusing to copy a symlink from ${src}" >&2
    exit 1
  fi
  mkdir -p "$dest"
  found=0
  for skill in "$src"/*/; do
    [ -d "$skill" ] || continue
    [ -f "${skill}SKILL.md" ] || continue
    found=1
    name=$(basename "$skill")
    rm -rf "${dest}/${name}"
    filelist=$(mktemp)
    find "$skill" -type f >"$filelist"
    while IFS= read -r file || [ -n "$file" ]; do
      [ -n "$file" ] || continue
      rel=${file#"$skill"}
      rel=${rel#/}
      case "$rel" in
        ""|..|../*|*/..|*/../*)
          echo "dg-skills: refusing ${rel}" >&2
          exit 1
          ;;
      esac
      out="${dest}/${name}/${rel}"
      mkdir -p "$(dirname "$out")"
      cp "$file" "$out"
      chmod 644 "$out"
      printf '%s\n' "${name}/${rel}" >>"$manifest"
    done <"$filelist"
    rm -f "$filelist"
  done
  if [ "$found" -ne 1 ]; then
    echo "dg-skills: ${src} has no skill directories" >&2
    exit 1
  fi
  sort "$manifest"
  count=$(wc -l <"$manifest" | tr -d " ")
  echo "Installed ${count} skill files at ${dest}."
  echo "Skills-only install: no binaries were fetched and no skill content was executed."
  rm -f "$manifest"
}

skills_tree_source() {
  if [ -n "${DG_SKILLS_SOURCE:-}" ]; then
    printf '%s\n' "$DG_SKILLS_SOURCE"
    return
  fi
  script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
  repo=$(CDPATH= cd -- "$script_dir/../.." && pwd)
  if [ -d "$repo/plugins/dg/skills" ]; then
    printf '%s\n' "$repo/plugins/dg/skills"
    return
  fi
  if [ -d "plugins/dg/skills" ]; then
    printf '%s\n' "$(pwd)/plugins/dg/skills"
    return
  fi
  tmp=$(mktemp -d)
  archive="${tmp}/dg-ai.tar.gz"
  curl -fsSL -H "User-Agent: dg-ai" \
    "https://github.com/detailedghost/dg-ai/archive/refs/heads/master.tar.gz" -o "$archive"
  tar -xzf "$archive" -C "$tmp"
  printf '%s\n' "${tmp}/dg-ai-master/plugins/dg/skills"
}

if [ "$SKILLS_ONLY" = "1" ]; then
  if [ "$CLI_ONLY" = "1" ]; then
    echo "dg-skills: pass only one of --skills-only and --cli-only" >&2
    exit 1
  fi
  dest="${DG_SKILLS_DEST:-${DG_HOME:-$HOME/.dg}/skills}"
  copy_skill_tree "$(skills_tree_source)" "$dest"
  exit 0
fi

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
