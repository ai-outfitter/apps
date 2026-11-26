#!/usr/bin/env bash
# Overlay tracked platform source on the existing PlanWork box and build the
# installed package from committed Apps source. No product checkout is edited.
set -euo pipefail
if [[ $# != 6 ]]; then
  echo "Usage: $0 <apps-ref> <webapp-repo> <webapp-ref> <planwork-box> <new-image-tag> <fresh-private-output>" >&2
  exit 2
fi
umask 077
runner=$(cd -- "$(dirname -- "$0")" && pwd)
apps=$(git -C "$runner" rev-parse --show-toplevel)
webapp=$(git -C "$2" rev-parse --show-toplevel)
parent=$(cd -- "$(dirname -- "$6")" && pwd)
if git -C "$parent" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Keep build output outside Git worktrees" >&2
  exit 2
fi
out="$parent/$(basename -- "$6")"
app_commit=$(git -C "$apps" rev-parse --verify --end-of-options "$1^{commit}")
web_commit=$(git -C "$webapp" rev-parse --verify --end-of-options "$3^{commit}")
web_tree=$(git -C "$webapp" rev-parse "$web_commit^{tree}")
read -r prior_commit prior_tree prior_id < <(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const {platformCommit, platformTree, imageId} = JSON.parse(readFileSync(process.argv[1], "utf8"));
  console.log(platformCommit, platformTree, imageId);
' "$runner/../software-foundry-planwork-eval-284/pins.json")
read -r base_id base_tree < <(podman image inspect "$4" --format '{{.Id}} {{index .Config.Labels "io.outfitter.webapp.tree"}}')
[[ "${base_id#sha256:}" == "$prior_id" && "$base_tree" == "$prior_tree" ]]
git -C "$webapp" diff --no-renames --quiet --diff-filter=D "$prior_commit" "$web_commit" || {
  echo "This source delta removes files. Use a full box build for this revision." >&2
  exit 2
}
mkdir -- "$out"
mkdir "$out/source" "$out/package" "$out/image"
git -C "$webapp" diff --no-renames --name-only -z "$prior_commit" "$web_commit" > "$out/image/paths"
mapfile -d '' -t paths < "$out/image/paths"
if (( ${#paths[@]} == 0 )); then
  echo "Use the original PlanWork image for an unchanged platform" >&2
  exit 2
fi
git -C "$webapp" archive "$web_commit" -- "${paths[@]}" > "$out/image/source.tar"
(cd "$out/image" && sha256sum source.tar > source.sha256)
cat > "$out/image/Containerfile" <<'INNER'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
COPY source.tar /tmp/forgejo-eval-source.tar
RUN tar --no-same-owner -xf /tmp/forgejo-eval-source.tar -C /app && \
    tar -tf /tmp/forgejo-eval-source.tar | sed -n 's|^workspace/runtime/||p' | while IFS= read -r file; do \
      if [ -f "/app/workspace/runtime/$file" ]; then install -m 0644 "/app/workspace/runtime/$file" "/opt/workspace/$file"; fi; \
    done && rm /tmp/forgejo-eval-source.tar && find /opt/workspace -maxdepth 1 -type f -exec chmod a+r {} +
USER node
INNER
podman build --network=none --pull=never --label "io.outfitter.webapp.tree=$web_tree" \
  --label "io.outfitter.webapp.commit=$web_commit" --build-arg "BASE_IMAGE=$base_id" -t "$5" "$out/image" > "$out/image/build.log" 2>&1
podman image inspect "$5" --format '{{.Id}}' > "$out/image/id.txt"
git -C "$apps" archive "$app_commit" | tar -x -C "$out/source"
git -C "$apps" rev-parse "$app_commit^{tree}" > "$out/package/apps-tree.txt"
printf '%s\n' "$app_commit" > "$out/apps-commit.txt"
export ASTRO_TELEMETRY_DISABLED=1
(
  cd "$out/source"
  npm ci --offline --no-audit --no-fund
  npm exec --offline --workspace @ai-outfitter/app-software-foundry -- \
    outfitter-app-build --mode operational --output "$out/package/software-foundry.operational.json"
  cp apps/software-foundry/graph/schema.graphql apps/software-foundry/graph/documents.json "$out/package"
) > "$out/package-build.log" 2>&1
