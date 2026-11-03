#!/bin/sh
# Install the dg runtime and bundle into ${DG_HOME:-~/.dg}, then run `dg-skills install`.
#
#   curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
#   ... | sh -s -- --cli-only    (or DG_CLI_ONLY=1): skip the extension.
#   ... | sh -s -- --agent-only  (or DG_AGENT_ONLY=1): install for a non-Claude agent that only needs phone.
#   ... | sh -s -- --skills-only (or DG_SKILLS_ONLY=1): copy the skill files, then install the runtime and
#       bundle only. It runs no `dg-skills install`, fetches no extension and executes no skill content.
#       DG_SKILLS_NO_CLI=1 keeps it an offline copy of the skill files (nothing is downloaded from a release).
#   ... | sh -s -- --version <x.y.z> (also --version=<x.y.z>, or DG_VERSION=<x.y.z>): install that release.
#
# Layout: runtime/bun-v<bun>, lib/<release>, runtime/current and lib/current links, and
# bin/dg-skills, bin/dg-agent, bin/dg-daemon shims. Every download is verified against
# SHA256SUMS or runtime.json before anything is installed. Re-running upgrades in place.
# Windows: use bootstrap.ps1 instead.
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

die() {
  echo "dg-skills: $1" >&2
  exit 1
}

CURL="${DG_CURL:-curl}"
UNAME="${DG_UNAME:-uname}"

link_current() {
  staged="$1.$$.tmp"
  rm -f "$staged"
  ln -s "$2" "$staged"
  mv -T "$staged" "$1" 2>/dev/null || mv -h -f "$staged" "$1" 2>/dev/null || {
    rm -f "$staged"
    die "could not link $1"
  }
}

# Copy skill directories as data. A skill is an immediate child that contains
# SKILL.md. The same rule lives in @dg/common filesToInstall. Symlinks are
# refused. Files are written mode 0644 and never executed.
retired_is_dg_copy() {
  case $2 in
    teach) known="b32cdde3ab7f7239d157dd2225c984e48c02aa981cb962b42cdda5cdd1c4dc68 bb06ec5c6763216f76a7af5fbbea839476008747740ded023d285a5afddbd3c9" ;;
    wait-what) known="3ff07fa007759e417d95c4885ed333a84119cc0d621f7e3d805ca46b6ffb3dd6 6f40fe8148898ee8cb306b8fec3f8f674ee346f5ef54bf9f2d2790e43e1e1f4a" ;;
    *) return 0 ;;
  esac
  [ -f "$1/$2/SKILL.md" ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    hash=$(sha256sum "$1/$2/SKILL.md" | cut -d' ' -f1)
  else
    hash=$(shasum -a 256 "$1/$2/SKILL.md" | cut -d' ' -f1)
  fi
  case " $known " in
    *" $hash "*) return 0 ;;
  esac
  return 1
}

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
  for retired in phone-friend teach wait-what; do
    if retired_is_dg_copy "$dest" "$retired"; then
      rm -rf "${dest:?}/${retired}"
    fi
  done
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
candidates=""

resolve_release() {
  [ -n "${tag}" ] && return
  want=""
  if [ -n "${PINNED_VERSION}" ]; then
    want="v${PINNED_VERSION}"
  fi
  page=1
  while [ "${page}" -le "${PAGE_CAP}" ]; do
    batch=$("$CURL" -fsSL -H "User-Agent: dg-ai" \
      "https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}")
    releases="${releases}${batch}"
    found=$(printf '%s' "${batch}" | tr -d '\n' |
      grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"v[0-9]+\.[0-9]+\.[0-9]+"([^{}]*"draft"[[:space:]]*:[[:space:]]*true)?' |
      grep -v 'true$' |
      sed -E 's/.*"(v[^"]*)".*/\1/' || true)
    candidates="${candidates}${found}
"
    batch_count=$(printf '%s' "${batch}" | grep -o '"tag_name"[[:space:]]*:' | wc -l)
    [ "${batch_count}" -lt "${PER_PAGE}" ] && break
    page=$((page + 1))
  done

  if [ -n "${want}" ]; then
    if printf '%s\n' "${candidates}" | grep -qxF "${want}"; then
      tag="${want}"
    else
      die "no release named ${want} found"
    fi
  else
    tag=$(printf '%s' "${candidates}" | grep -v '^$' |
      sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)
    [ -n "${tag}" ] || die "no vX.Y.Z release found"
  fi
  VERSION=$(normalize_version "${tag}")
}

extract_source_archive() {
  archive_file=$1
  extract_dir=$2
  mkdir -p "$extract_dir"
  tar -xzf "$archive_file" -C "$extract_dir"
  set -- "$extract_dir"/*/
  if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
    echo "dg-skills: expected one directory in the source archive" >&2
    exit 1
  fi
  printf '%s' "${1%/}"
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
  "$CURL" -fsSL -H "User-Agent: dg-ai" \
    "https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz" -o "$archive"
  source_root=$(extract_source_archive "$archive" "${tmp}/source")
  SKILLS_SRC="${source_root}/plugins/dg/skills"
}

ROOT="${DG_HOME:-${HOME}/.dg}"

if [ "$SKILLS_ONLY" = "1" ]; then
  skills_tree_source
  copy_skill_tree "${SKILLS_SRC}" "${DG_SKILLS_DEST:-${ROOT}/skills}"
  if [ "${DG_SKILLS_NO_CLI:-0}" = "1" ]; then
    echo "Skipped the dg-skills CLI (DG_SKILLS_NO_CLI=1): offline copy only."
    exit 0
  fi
fi

os=$("$UNAME" -s)
arch=$("$UNAME" -m)
case "$os" in
Linux) family="linux" ;;
Darwin) family="darwin" ;;
*) die "unsupported OS '$os' - use bootstrap.ps1 on Windows" ;;
esac
case "$arch" in
x86_64 | amd64) cpu="x64" ;;
aarch64 | arm64) cpu="arm64" ;;
*) die "unsupported arch '$arch'" ;;
esac
platform="${family}-${cpu}"
if [ "$platform" = "linux-x64" ]; then
  cpuinfo="${DG_CPUINFO_FILE:-/proc/cpuinfo}"
  if [ -r "$cpuinfo" ] && ! grep -qw avx2 "$cpuinfo"; then
    platform="linux-x64-baseline"
  fi
fi

for tool in "$CURL" tar unzip; do
  command -v "$tool" >/dev/null 2>&1 || die "${tool} is required"
done
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  die "sha256sum or shasum is required"
fi

sha256_of() {
  $SHA_CMD "$1" | awk '{print $1}' | tr 'A-F' 'a-f'
}

verify_sha256() {
  [ "$(sha256_of "$1")" = "$3" ] || die "checksum mismatch for $2"
}

asset_url() {
  name=$(printf '%s' "$1" | sed -e 's/[.[\^$*]/\\&/g')
  tag_pattern=$(printf '%s' "${tag}" | sed -e 's/[.[\^$*]/\\&/g')
  printf '%s' "${releases}" |
    grep -oE "https://[^\"]+/download/${tag_pattern}/${name}\"" |
    head -1 | tr -d '"'
}

download_asset() {
  url=$(asset_url "$1")
  [ -n "${url}" ] || die "no $1 asset in ${tag}"
  "$CURL" -fsSL -H "User-Agent: dg-ai" -o "$2" "$url"
}

sums_entry() {
  awk -v name="$1" '
    $1 ~ /^[0-9A-Fa-f]{64}$/ {
      n = $2
      sub(/^\*/, "", n)
      if (n == name) { print $1; exit }
    }
  ' "${WORK}/SHA256SUMS" | tr 'A-F' 'a-f'
}

json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

resolve_release

WORK=$(mktemp -d)
track_tmp "${WORK}"

download_asset SHA256SUMS "${WORK}/SHA256SUMS"
download_asset runtime.json "${WORK}/runtime.json"
expected=$(sums_entry runtime.json)
[ -n "${expected}" ] || die "SHA256SUMS in ${tag} has no entry for runtime.json"
verify_sha256 "${WORK}/runtime.json" runtime.json "${expected}"

flat=$(tr -d ' \n\t\r' <"${WORK}/runtime.json")
BUN_VERSION=$(json_field "${flat}" version)
entry=$(printf '%s' "${flat}" | sed -n "s/.*\"${platform}\":{\([^}]*\)}.*/\1/p")
BUN_FILE=$(json_field "${entry}" file)
BUN_SHA=$(json_field "${entry}" sha256)
[ -n "${BUN_VERSION}" ] && [ -n "${BUN_FILE}" ] && [ -n "${BUN_SHA}" ] ||
  die "runtime.json in ${tag} has no bun asset for ${platform}"

BUN_DIR="${ROOT}/runtime/bun-v${BUN_VERSION}"
LIB_DIR="${ROOT}/lib/${VERSION}"

if [ ! -x "${BUN_DIR}/bun" ]; then
  echo "Downloading bun ${BUN_VERSION} (${platform})..."
  "$CURL" -fsSL -H "User-Agent: dg-ai" -o "${WORK}/${BUN_FILE}" \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_FILE}"
  verify_sha256 "${WORK}/${BUN_FILE}" "${BUN_FILE}" "${BUN_SHA}"
  NEED_BUN=1
else
  NEED_BUN=0
fi

LIB_ASSET="dg-lib-${VERSION}.tar.gz"
if [ ! -f "${LIB_DIR}/dg.js" ]; then
  echo "Downloading ${LIB_ASSET}..."
  expected=$(sums_entry "${LIB_ASSET}")
  [ -n "${expected}" ] || die "SHA256SUMS in ${tag} has no entry for ${LIB_ASSET}"
  download_asset "${LIB_ASSET}" "${WORK}/${LIB_ASSET}"
  verify_sha256 "${WORK}/${LIB_ASSET}" "${LIB_ASSET}" "${expected}"
  NEED_LIB=1
else
  NEED_LIB=0
fi

mkdir -p "${ROOT}/runtime" "${ROOT}/lib" "${ROOT}/bin"

if [ "${NEED_BUN}" = "1" ]; then
  stage=$(mktemp -d "${ROOT}/runtime/.stage.XXXXXX")
  track_tmp "${stage}"
  unzip -q "${WORK}/${BUN_FILE}" -d "${stage}"
  inner=${BUN_FILE%.zip}
  [ -f "${stage}/${inner}/bun" ] || die "${BUN_FILE} has no ${inner}/bun"
  chmod 755 "${stage}/${inner}/bun"
  rm -rf "${BUN_DIR}"
  mv "${stage}/${inner}" "${BUN_DIR}"
fi

if [ "${NEED_LIB}" = "1" ]; then
  stage=$(mktemp -d "${ROOT}/lib/.stage.XXXXXX")
  track_tmp "${stage}"
  tar -xzf "${WORK}/${LIB_ASSET}" -C "${stage}"
  [ -f "${stage}/dg.js" ] || die "${LIB_ASSET} has no dg.js"
  rm -rf "${LIB_DIR}"
  mv "${stage}" "${LIB_DIR}"
  chmod 755 "${LIB_DIR}"
fi

link_current "${ROOT}/runtime/current" "bun-v${BUN_VERSION}"
link_current "${ROOT}/lib/current" "${VERSION}"

for program in dg-skills dg-agent dg-daemon; do
  shim=$(mktemp "${ROOT}/bin/.${program}.XXXXXX")
  track_tmp "${shim}"
  printf '#!/bin/sh\nexec "%s/runtime/current/bun" "%s/lib/current/dg.js" %s "$@"\n' \
    "${ROOT}" "${ROOT}" "${program}" >"${shim}"
  chmod 755 "${shim}"
  mv -f "${shim}" "${ROOT}/bin/${program}"
  rm -f "${ROOT}/bin/.${program}.version"
done

echo "dg runtime ${BUN_VERSION} and bundle ${VERSION} installed at ${ROOT}"

case ":${PATH}:" in
*":${ROOT}/bin:"*) ;;
*) echo "Add to PATH:  export PATH=\"${ROOT}/bin:\$PATH\"" ;;
esac

[ "${SKILLS_ONLY}" = "1" ] && exit 0

install_args=""
[ "${CLI_ONLY}" = "1" ] && install_args=" --cli-only"
[ "${AGENT_ONLY}" = "1" ] && install_args=" --agent-only"
[ -n "${PINNED_VERSION}" ] && install_args="${install_args} --version ${PINNED_VERSION}"

if [ "${CLI_ONLY}" != "1" ] && [ "${AGENT_ONLY}" != "1" ]; then
  echo "Setting up the dg-ai-extension..."
fi
DG_SKILLS_BOOTSTRAP=1 "${ROOT}/bin/dg-skills" install${install_args} </dev/null

if [ "${DG_INSTALL_CODEX:-0}" = "1" ]; then
  CODEX_ROOT="${CODEX_HOME:-${HOME}/.codex}"
  tmpdir=$(mktemp -d)
  track_tmp "${tmpdir}"
  archive="${tmpdir}/dg-ai.tar.gz"
  "$CURL" -fsSL -H "User-Agent: dg-ai" \
    "https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz" -o "${archive}"
  mkdir -p "${CODEX_ROOT}/skills"
  source_root=$(extract_source_archive "${archive}" "${tmpdir}/source")
  for skill in "${source_root}/plugins/dg/skills"/*/; do
    if { [ "${CLI_ONLY}" = "1" ] || [ "${AGENT_ONLY}" = "1" ]; } && grep -qE '^requires:.*extension' "${skill}SKILL.md"; then
      continue
    fi
    cp -R "${skill}" "${CODEX_ROOT}/skills/"
  done
  echo "Codex skills installed in ${CODEX_ROOT}/skills"
fi
