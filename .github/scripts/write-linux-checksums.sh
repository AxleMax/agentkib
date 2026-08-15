#!/usr/bin/env bash
set -euo pipefail

search_root=${1:-target}
if [[ ! -d "$search_root" ]]; then
  echo "Artifact root does not exist: $search_root" >&2
  exit 1
fi

count=0
while IFS= read -r -d '' artifact; do
  checksum="${artifact}.sha256"
  (
    cd "$(dirname "$artifact")"
    sha256sum "$(basename "$artifact")" > "$(basename "$checksum")"
  )
  printf 'Wrote %s\n' "$checksum"
  count=$((count + 1))
done < <(find "$search_root" -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -print0 | sort -z)

if ((count == 0)); then
  echo "No Linux packages found under $search_root" >&2
  exit 1
fi
