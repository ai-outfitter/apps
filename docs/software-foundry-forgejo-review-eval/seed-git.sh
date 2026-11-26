#!/bin/sh
set -eu
cd "$1"
fixture_git() {
  env -i PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_AUTHOR_NAME='Fixture author' GIT_AUTHOR_EMAIL=fixture@example.test \
    GIT_COMMITTER_NAME='Fixture author' GIT_COMMITTER_EMAIL=fixture@example.test \
    GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
    git -c core.attributesFile=/dev/null -c core.autocrlf=false -c commit.gpgsign=false "$@"
}
fixture_git init -q -b main --template= --object-format=sha1
printf '# Synthetic lamp\n' > README.md
fixture_git add README.md
fixture_git commit -qm 'Seed the synthetic repository'
fixture_git rev-parse HEAD
