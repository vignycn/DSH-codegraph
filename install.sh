#!/usr/bin/env bash
# Wire the CodeGraph MCP server into a DeepSeek Harness (DSH) profile.
#
# Appends an `insert:` entry to the profile's cordis.patch.yml so DSH's
# bundled @deepseek-ai/dsh-mcp-client connects to `codegraph serve --mcp`.
# The previous file is backed up and any earlier mcp-codegraph block is
# replaced, so re-running is safe. DSH hot-reloads the file: no restart needed.
set -euo pipefail

PROJECT=""
PROFILE="desktop"

usage() {
  cat <<'EOF'
Usage: ./install.sh <project-path> [--profile <name>]

  <project-path>       Directory indexed by CodeGraph (contains .codegraph/)
  --profile <name>     DSH profile under ~/.dsh/profiles (default: desktop)
  -h, --help           Show this help

Example:
  ./install.sh ~/src/my-project
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--profile) PROFILE="${2:-}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    -*)           echo "unknown option: $1" >&2; usage; exit 2 ;;
    *)            PROJECT="$1"; shift ;;
  esac
done

if [ -z "$PROJECT" ]; then
  usage
  exit 2
fi

if [ ! -d "$PROJECT" ]; then
  echo "error: not a directory: $PROJECT" >&2
  exit 1
fi
PROJECT="$(cd "$PROJECT" && pwd)"

if [ ! -d "$PROJECT/.codegraph" ]; then
  echo "warning: no .codegraph/ in $PROJECT" >&2
  echo "warning: run 'codegraph init' there first, otherwise the tool answers" >&2
  echo "warning: 'No CodeGraph project is loaded for this session.'" >&2
fi

# ---- CodeGraph install check (mirrors the patch's runtime resolver) ----
resolve_codegraph() {
  if [ -n "${CODEGRAPH_BIN:-}" ] && [ -x "$CODEGRAPH_BIN" ]; then
    printf '%s' "$CODEGRAPH_BIN"; return 0
  fi
  if p="$(command -v codegraph 2>/dev/null)" && [ -n "$p" ]; then
    printf '%s' "$p"; return 0
  fi
  if [ -x "${CODEGRAPH_INSTALL_DIR:-$HOME/.codegraph}/current/bin/codegraph" ]; then
    printf '%s' "${CODEGRAPH_INSTALL_DIR:-$HOME/.codegraph}/current/bin/codegraph"; return 0
  fi
  if [ -x "$HOME/.local/bin/codegraph" ]; then
    printf '%s' "$HOME/.local/bin/codegraph"; return 0
  fi
  return 1
}

CG="$(resolve_codegraph || true)"
if [ -z "$CG" ]; then
  echo "warning: no runnable 'codegraph' found (PATH, \$CODEGRAPH_BIN," >&2
  echo "warning: \$CODEGRAPH_INSTALL_DIR/current, or ~/.codegraph/current)." >&2
  echo "warning: the plugin will activate but expose no tools." >&2
else
  echo "CodeGraph: $CG"
fi

PATCH="$HOME/.dsh/profiles/$PROFILE/cordis.patch.yml"
if [ ! -f "$PATCH" ]; then
  echo "error: profile patch file not found: $PATCH" >&2
  echo "hint : start DeepSeek Harness once to create the profile, or pass --profile <name>" >&2
  if [ -d "$HOME/.dsh/profiles" ]; then
    echo "       existing profiles: $(ls -1 "$HOME/.dsh/profiles" | tr '\n' ' ')" >&2
  fi
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SCRIPT_DIR/cordis.patch.yml"
if [ ! -f "$TEMPLATE" ]; then
  echo "error: template missing: $TEMPLATE (keep install.sh and cordis.patch.yml together)" >&2
  exit 1
fi

# Everything after the marker is the actual patch document.
BLOCK="$(awk '/^--- cut here ---$/{flag=1;next} flag' "$TEMPLATE")"
if [ -z "$BLOCK" ]; then
  echo "error: could not find the '--- cut here ---' marker in $TEMPLATE" >&2
  exit 1
fi

# YAML single-quoted scalar: escape ' by doubling it, and keep the
# substitution literal (it may contain / & \ characters).
PROJECT_YAML="$(printf '%s' "$PROJECT" | sed "s/'/''/g" | sed -e 's/[\/&]/\\&/g')"
BLOCK="$(printf '%s\n' "$BLOCK" | sed "s/REPLACE_WITH_PROJECT_PATH/$PROJECT_YAML/g")"

if printf '%s' "$BLOCK" | grep -q 'REPLACE_WITH_PROJECT_PATH'; then
  echo "error: path substitution failed" >&2
  exit 1
fi

BACKUP="$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
cp "$PATCH" "$BACKUP"
echo "Backup: $BACKUP"

TMP_BODY="$(mktemp)"
TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_BODY" "$TMP_OUT"' EXIT

# Drop any existing top-level `- insert:` block that mentions mcp-codegraph.
awk '
  function flush() {
    if (buf == "") return
    if (buf ~ /mcp-codegraph/) { buf = ""; return }
    print buf
    buf = ""
  }
  /^- / { flush(); buf = $0; next }
  { if (buf == "") print; else buf = buf "\n" $0 }
  END { flush() }
' "$PATCH" | grep -v -E '^[[:space:]]*\[\][[:space:]]*$' > "$TMP_BODY" || true

{
  cat "$TMP_BODY"
  # Keep one blank line between the previous document and our entry.
  if [ -s "$TMP_BODY" ]; then printf '\n'; fi
  printf '%s\n' "$BLOCK"
} > "$TMP_OUT"

# Write without a BOM (a BOM can upset YAML parsers).
cat "$TMP_OUT" > "$PATCH"

echo
echo "Installed: $PATCH"
echo "  project : $PROJECT"
echo "  server  : codegraph"
echo "  tool    : mcp__codegraph__codegraph_explore"
echo
echo "No restart needed - DSH hot-reloads this file within a few seconds."
echo "Verify by asking the model to 'use codegraph to show <symbol>'."
echo
echo "Rollback: cp '$BACKUP' '$PATCH'"
