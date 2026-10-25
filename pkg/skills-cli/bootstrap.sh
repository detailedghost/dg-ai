#!/bin/sh
# Install the compiled dg-skills CLI for the current platform into ${DG_HOME:-~/.dg}/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.20.0/pkg/skills-cli/bootstrap.sh | sh
#   ... | sh -s -- --cli-only   (or DG_CLI_ONLY=1): skip the extension, dg-daemon and dg-agent
#   ... | sh -s -- --agent-only (or DG_AGENT_ONLY=1): install dg-agent too, for a non-Claude
#       agent that only needs phone; still skips the extension and dg-daemon.
#   ... | sh -s -- --skills-only (or DG_SKILLS_ONLY=1): copy skill instruction files, then
#       install only the dg-skills CLI (checksum-verified like the default path).
#       No dg-daemon, dg-agent or extension is fetched and no skill content is executed.
#       DG_SKILLS_NO_CLI=1 keeps it an offline copy (no CLI download).
#   ... | sh -s -- --version <x.y.z> (also --version=<x.y.z>, or DG_VERSION=<x.y.z>):
#       pin skills-v/daemon-v/agent-v/ext-v to that release; a leading v or skills-v
#       prefix is accepted. With --skills-only this script installs that exact
#       skills-v<x.y.z> binary directly. Every other mode downloads the newest
#       skills-v* binary to a temp path instead and runs its `install --version
#       <x.y.z>` (deleted afterward either way), because that is the binary that
#       knows how to resolve, download and verify a pinned release — the newest
#       release may predate --version support. That install checks every release
#       the mode needs, then downloads and verifies every artifact (with checksums)
#       into staging, and only then replaces anything, including dg-skills itself
#       and its version stamp. Unset: install the newest of each, warning and
#       skipping one that is missing.
#
# Idempotent: re-running overwrites the binary with the newest skills-v* release
# (or the pinned one, with --version).
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
AGENT_ONLY="${DG_AGENT_ONLY:-0}"
VERSION_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cli-only) CLI_ONLY=1 ;;
    --skills-only) SKILLS_ONLY=1 ;;
    --agent-only) AGENT_ONLY=1 ;;
    --version=*) VERSION_ARG=${1#--version=} ;;
    --version)
      shift
      [ "$#" -gt 0 ] || { echo "dg-skills: --version requires a value" >&2; exit 1; }
      VERSION_ARG=$1
      ;;
  esac
  shift
done
if [ "$SKILLS_ONLY" = "1" ] && [ "$CLI_ONLY" = "1" ]; then
  echo "dg-skills: pass only one of --skills-only and --cli-only" >&2
  exit 1
fi
if [ "$SKILLS_ONLY" = "1" ] && [ "$AGENT_ONLY" = "1" ]; then
  echo "dg-skills: pass only one of --skills-only and --agent-only" >&2
  exit 1
fi
if [ "$CLI_ONLY" = "1" ] && [ "$AGENT_ONLY" = "1" ]; then
  echo "dg-skills: pass only one of --cli-only and --agent-only" >&2
  exit 1
fi

normalize_version() {
  v=$1
  case "$v" in
    skills-v*) v=${v#skills-v} ;;
    v*) v=${v#v} ;;
  esac
  printf '%s' "$v"
}

PINNED_VERSION=""
if [ -n "${VERSION_ARG}" ]; then
  PINNED_VERSION=$(normalize_version "${VERSION_ARG}")
elif [ -n "${DG_VERSION:-}" ]; then
  PINNED_VERSION=$(normalize_version "${DG_VERSION}")
fi

TMP_PATHS=""
track_tmp() {
  TMP_PATHS="${TMP_PATHS}${1}
"
}
cleanup_tmp() {
  printf '%s' "$TMP_PATHS" | while IFS= read -r path || [ -n "$path" ]; do
    [ -n "$path" ] && rm -rf "$path"
  done
}
trap cleanup_tmp EXIT

# Copy skill directories as data. A skill is an immediate child that contains
# SKILL.md. The same rule lives in @dg/common filesToInstall. Symlinks are
# refused. Files are written mode 0644 and never executed.
copy_skill_tree() {
  src=$1
  dest=$2
  manifest=$(mktemp)
  track_tmp "$manifest"
  if [ ! -d "$src" ]; then
    echo "dg-skills: no skills directory at ${src}" >&2
    exit 1
  fi
  if find "$src" -type l | grep -q .; then
    echo "dg-skills: refusing to copy a symlink from ${src}" >&2
    exit 1
  fi
  refuse_persona_links "$src"
  mkdir -p "$dest"
  found=0
  for skill in "$src"/*/; do
    [ -d "$skill" ] || continue
    [ -f "${skill}SKILL.md" ] || continue
    found=1
    name=$(basename "$skill")
    rm -rf "${dest}/${name}"
    filelist=$(mktemp)
    track_tmp "$filelist"
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
  copy_personas "$src" "$dest"
  echo "Skills-only install: no skill content was executed. Fetching only the dg-skills CLI (no daemon, agent or extension)."
  rm -f "$manifest"
}

persona_source() {
  CDPATH= cd -- "$1/.." 2>/dev/null && printf '%s\n' "$(pwd)/agents"
}

refuse_persona_links() {
  agents_src=$(persona_source "$1") || return 0
  [ -d "$agents_src" ] || return 0
  if find "$agents_src" -type l | grep -q .; then
    echo "dg-skills: refusing to copy a symlink persona from ${agents_src}" >&2
    exit 1
  fi
}

copy_personas() {
  agents_src=$(persona_source "$1") || return 0
  [ -d "$agents_src" ] || return 0
  agents=$(CDPATH= cd -- "$2/.." && pwd)/agents
  mkdir -p "$agents"
  count=0
  for persona in "$agents_src"/*.md; do
    [ -f "$persona" ] || continue
    rm -f "${agents}/$(basename "$persona")"
    cp "$persona" "${agents}/$(basename "$persona")"
    chmod 644 "${agents}/$(basename "$persona")"
    count=$((count + 1))
  done
  [ "$count" -gt 0 ] && echo "Installed ${count} personas at ${agents}."
  return 0
}

REPO="detailedghost/dg-ai"
PER_PAGE=100
PAGE_CAP=10
releases=""
tag=""

resolve_release() {
  [ -n "${tag}" ] && return
  if [ "${SKILLS_ONLY}" = "1" ] && [ -n "${PINNED_VERSION}" ]; then
    want="skills-v${PINNED_VERSION}"
    want_pattern=$(printf '%s' "${want}" | sed -e 's/[.[\^$*]/\\&/g')
  fi
  page=1
  while [ -z "${tag}" ] && [ "${page}" -le "${PAGE_CAP}" ]; do
    batch=$(curl -fsSL -H "User-Agent: dg-ai" \
      "https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}")
    releases="${releases}${batch}"
    if [ -n "${want:-}" ]; then
      if printf '%s' "${batch}" |
        grep -qE "\"tag_name\"[[:space:]]*:[[:space:]]*\"${want_pattern}\""; then
        tag="${want}"
      fi
    else
      tag=$(printf '%s' "${batch}" |
        grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"skills-v[^"]*"' |
        head -1 |
        sed -E 's/.*"(skills-v[^"]*)".*/\1/')
    fi
    batch_count=$(printf '%s' "${batch}" | grep -o '"tag_name"[[:space:]]*:' | wc -l)
    [ "${batch_count}" -lt "${PER_PAGE}" ] && break
    page=$((page + 1))
  done

  if [ -z "${tag}" ]; then
    scanned=$(printf '%s' "${releases}" | grep -o '"tag_name"[[:space:]]*:' | wc -l)
    if [ -n "${want:-}" ]; then
      echo "dg-skills: no release named ${want} found in the ${scanned} releases scanned" >&2
    else
      echo "dg-skills: no skills-v* release found in the ${scanned} releases scanned" >&2
    fi
    exit 1
  fi
}

skills_tree_source() {
  if [ -n "${DG_SKILLS_SOURCE:-}" ]; then
    SKILLS_SRC="$DG_SKILLS_SOURCE"
    return
  fi
  script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
  repo=$(CDPATH= cd -- "$script_dir/../.." && pwd)
  if [ -d "$repo/plugins/dg/skills" ]; then
    SKILLS_SRC="$repo/plugins/dg/skills"
    return
  fi
  if [ -d "plugins/dg/skills" ]; then
    SKILLS_SRC="$(pwd)/plugins/dg/skills"
    return
  fi
  tmp=$(mktemp -d)
  track_tmp "$tmp"
  archive="${tmp}/dg-ai.tar.gz"
  resolve_release
  curl -fsSL -H "User-Agent: dg-ai" \
    "https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz" -o "$archive"
  tar -xzf "$archive" -C "$tmp"
  SKILLS_SRC="${tmp}/dg-ai-${tag}/plugins/dg/skills"
}

if [ "$SKILLS_ONLY" = "1" ]; then
  dest="${DG_SKILLS_DEST:-${DG_HOME:-$HOME/.dg}/skills}"
  skills_tree_source
  copy_skill_tree "${SKILLS_SRC}" "$dest"
  if [ "${DG_SKILLS_NO_CLI:-0}" = "1" ]; then
    echo "Skipped the dg-skills CLI (DG_SKILLS_NO_CLI=1): offline copy only."
    exit 0
  fi
fi

BIN_DIR="${DG_HOME:-${HOME}/.dg}/bin"
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

resolve_release

url=$(printf '%s' "${releases}" |
  grep -oE "https://[^\"]+/download/${tag}/${asset}" |
  head -1)

if [ -z "${url}" ]; then
  echo "dg-skills: no ${asset} asset in ${tag}" >&2
  exit 1
fi

# Verify a downloaded file against SHA256SUMS when that asset is on this same release.
# A missing checksum file is not an error: older skills-v* releases predate it.
verify_sha256() {
  target=$1
  sums_url=$(printf '%s' "${releases}" |
    grep -oE "https://[^\"]+/download/${tag}/SHA256SUMS" |
    head -1)
  if [ -z "${sums_url}" ]; then
    return 0
  fi
  sums_file=$(mktemp)
  track_tmp "${sums_file}"
  if ! curl -fsSL -H "User-Agent: dg-ai" -o "${sums_file}" "${sums_url}"; then
    rm -f "${target}" "${sums_file}"
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
    rm -f "${target}" "${sums_file}"
    echo "dg-skills: SHA256SUMS in ${tag} has no entry for ${asset}" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "${target}" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "${target}" | awk '{print $1}')
  else
    rm -f "${target}" "${sums_file}"
    echo "dg-skills: SHA256SUMS was published for ${tag} but sha256sum and shasum are missing" >&2
    exit 1
  fi
  actual=$(printf '%s' "${actual}" | tr 'A-F' 'a-f')
  rm -f "${sums_file}"
  if [ "${actual}" != "${expected}" ]; then
    rm -f "${target}"
    echo "dg-skills: checksum mismatch for ${asset} in ${tag}" >&2
    exit 1
  fi
}

# The binary this script just installed is current, so `dg-skills install`
# would otherwise say "already current" right after "installed".
run_install() {
  log=$(mktemp)
  track_tmp "${log}"
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

DELEGATE=0
if [ "${SKILLS_ONLY}" != "1" ] && [ -n "${PINNED_VERSION}" ]; then
  DELEGATE=1
  INSTALLER=$(mktemp "${BIN_DIR}/.dg-skills-installer.XXXXXX")
  track_tmp "${INSTALLER}"
else
  INSTALLER="${DEST}"
fi

curl -fsSL -H "User-Agent: dg-ai" -o "${INSTALLER}" "${url}"
verify_sha256 "${INSTALLER}"
chmod +x "${INSTALLER}"

if [ "${DELEGATE}" = "0" ]; then
  # Stamp the installed version so `dg-skills install` won't re-download the binary.
  version=${tag#skills-v}
  [ -n "${version}" ] && printf '%s\n' "${version}" >"${BIN_DIR}/.dg-skills.version"
  echo "dg-skills installed at ${DEST}"
fi

case ":${PATH}:" in
*":${BIN_DIR}:"*) ;;
*) echo "Add to PATH:  export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac

if [ "${SKILLS_ONLY}" = "1" ]; then
  # Skills-only stops at the CLI: no `dg-skills install`, so no daemon, agent or extension.
  exit 0
elif [ "${CLI_ONLY}" = "1" ]; then
  if [ -n "${PINNED_VERSION}" ]; then
    DG_SKILLS_BOOTSTRAP=1 run_install "${INSTALLER}" install --cli-only --version "${PINNED_VERSION}"
  else
    DG_SKILLS_BOOTSTRAP=1 run_install "${INSTALLER}" install --cli-only
  fi
elif [ "${AGENT_ONLY}" = "1" ]; then
  if [ -n "${PINNED_VERSION}" ]; then
    DG_SKILLS_BOOTSTRAP=1 run_install "${INSTALLER}" install --agent-only --version "${PINNED_VERSION}"
  else
    DG_SKILLS_BOOTSTRAP=1 run_install "${INSTALLER}" install --agent-only
  fi
else
  # Set up the browser extension too, so one command installs everything.
  echo "Setting up the dg-ai-extension…"
  if [ -n "${PINNED_VERSION}" ]; then
    DG_SKILLS_BOOTSTRAP=1 run_install "${INSTALLER}" install --version "${PINNED_VERSION}"
  else
    DG_SKILLS_BOOTSTRAP=1 run_install "${INSTALLER}" install
  fi
fi

# Optional Codex skill installation. Set DG_INSTALL_CODEX=1 to copy the
# repository's skills into CODEX_HOME (default: ~/.codex/skills).
if [ "${DG_INSTALL_CODEX:-0}" = "1" ]; then
  CODEX_ROOT="${CODEX_HOME:-${HOME}/.codex}"
  CODEX_TAG="${tag}"
  [ -n "${PINNED_VERSION}" ] && CODEX_TAG="skills-v${PINNED_VERSION}"
  tmpdir=$(mktemp -d)
  track_tmp "${tmpdir}"
  archive="${tmpdir}/dg-ai.tar.gz"
  curl -fsSL -H "User-Agent: dg-ai" \
    "https://github.com/${REPO}/archive/refs/tags/${CODEX_TAG}.tar.gz" -o "${archive}"
  mkdir -p "${CODEX_ROOT}/skills"
  tar -xzf "${archive}" -C "${tmpdir}"
  for skill in "${tmpdir}/dg-ai-${CODEX_TAG}/plugins/dg/skills"/*/; do
    if { [ "${CLI_ONLY}" = "1" ] || [ "${AGENT_ONLY}" = "1" ]; } && grep -qE '^requires:.*extension' "${skill}SKILL.md"; then
      continue
    fi
    cp -R "${skill}" "${CODEX_ROOT}/skills/"
  done
  echo "Codex skills installed in ${CODEX_ROOT}/skills"
fi
