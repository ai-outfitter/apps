#!/usr/bin/env bash
set -euo pipefail

runner_dir=$(cd -- "$(dirname -- "$0")" && pwd)
workshop_dir=$(cd -- "$runner_dir/../.." && pwd)
registry=ghcr.io/ai-outfitter/workspace-runtime
engine=${CONTAINER_ENGINE:-docker}
content_hash=$(cd -- "$runner_dir" && sha256sum Dockerfile cantilever.py fdm-asa.ini preflight.py preflight_http.py | sha256sum | cut -d' ' -f1)
tag="$registry:workshop-preflight-$content_hash"
pull_log=$(mktemp)
trap 'unlink "$pull_log"' EXIT

if "$engine" pull "$tag" >"$pull_log" 2>&1; then
  # Keep an existing published tag immutable, even if dependencies have moved.
  python3 "$workshop_dir/tests/preflight-release.py" "$tag" >&2
else
  if ! rg -iq 'manifest unknown|manifest .* not found' "$pull_log"; then
    cat "$pull_log" >&2
    exit 1
  fi
  "$engine" build --platform linux/amd64 -t "$tag" "$runner_dir" >&2
  python3 "$workshop_dir/tests/preflight-release.py" "$tag" >&2
  "$engine" push "$tag" >&2
  "$engine" pull "$tag" >&2
fi

reference=$("$engine" image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag" |
  rg "^$registry@sha256:[a-f0-9]{64}$" | head -n 1)
printf '%s\n' "$reference"
