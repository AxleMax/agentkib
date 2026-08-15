#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Linux ]]; then
  echo "This helper only builds Linux bundles." >&2
  exit 1
fi

# Tauri's RPM bundler preserves the mode of Cargo's output binary. Normalize
# the umask and any cached executable so packages remain runnable by non-root
# users even when the invoking shell uses a restrictive umask.
umask 022
workspace_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
main_binary="$workspace_root/target/release/agentkib-desktop"
if [[ -f "$main_binary" ]]; then
  chmod 0755 "$main_binary"
fi

cd "$workspace_root"
exec pnpm tauri build "$@"
