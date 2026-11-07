# A sealed Outfitter app box. Build from the root of this repository, with a
# checkout of the platform (ai-outfitter/webapp) as the `webapp` build context:
#   docker build --build-context webapp=../webapp --build-arg BOX_APP=software-foundry \
#     -f box/Dockerfile -t outfitter/software-foundry-box:dev .
# BOX_APP names apps/<app>; that app's box driver (apps/<app>/box/driver.mjs)
# runs the requests, and its operational package is built from this checkout.
# Run with no network except the model endpoint (see README):
#   docker run --rm -p 127.0.0.1:8787:8787 -v "$PWD/repo:/in/repo:ro" \
#     -v "$PWD/requests:/in/requests:ro" -v "$PWD/out:/out" outfitter/software-foundry-box:dev
ARG FORGEJO_IMAGE=codeberg.org/forgejo/forgejo:11
ARG RUSTFS_IMAGE=docker.io/rustfs/rustfs:1.0.0

FROM ${FORGEJO_IMAGE} AS forgejo
FROM ${RUSTFS_IMAGE} AS rustfs

# Replaced by --build-context webapp=<ai-outfitter/webapp checkout>; the build fails without it.
FROM scratch AS webapp

# The box app's operational package, built from this checkout.
FROM docker.io/library/node:24-bookworm-slim AS app
ARG BOX_APP=software-foundry
WORKDIR /apps
COPY . .
RUN test -f "apps/${BOX_APP}/box/driver.mjs" || { echo "apps/${BOX_APP} has no box driver" >&2; exit 1; }
RUN npm ci --no-audit --no-fund && mkdir -p /package && cd "apps/${BOX_APP}" && \
    npx outfitter-app-build --mode operational --output "/package/${BOX_APP}.operational.json"

FROM docker.io/library/node:24-bookworm-slim AS build
ARG BOX_APP=software-foundry
WORKDIR /app
COPY --from=webapp package*.json ./
COPY --from=webapp packages ./packages
COPY --from=webapp catalog ./catalog
RUN test -f package.json || { echo "Pass --build-context webapp=<ai-outfitter/webapp checkout>" >&2; exit 1; }
RUN npm pkg delete scripts.prepare && npm ci --no-audit --no-fund
COPY --from=webapp . .
# Released app packages are fetched and verified here, at build time only;
# the box app's package from this checkout replaces its released one.
RUN npm run --silent workflow-schema:check && npm run --silent apps:build
COPY --from=app /package/ /tmp/package/
RUN cp "/tmp/package/${BOX_APP}.operational.json" "src/generated/apps/${BOX_APP}.operational.json"
RUN cd workspace/runtime && npm ci --omit=dev --no-audit --no-fund
# The box harness and the app's driver, inside the checkout so they resolve its modules.
COPY box /app/.box
COPY apps/${BOX_APP}/box /app/.box/app

FROM docker.io/library/node:24-bookworm-slim
ARG BOX_APP=software-foundry
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git git-lfs python3 procps tini \
  && rm -rf /var/lib/apt/lists/*
COPY --from=forgejo /app/gitea/gitea /usr/local/bin/forgejo
COPY --from=rustfs /usr/bin/rustfs /usr/local/bin/rustfs
# The platform runs from its checkout through the local-organizations loader,
# which serves real app workers (the production Node build cannot dispatch apps).
COPY --from=build --chown=node:node /app /app
# The workspace runtime (pi and its tools), as the workspace image installs it.
COPY --from=build /app/workspace/runtime /opt/workspace
WORKDIR /app
ENV NODE_ENV=development PATH="/opt/workspace/node_modules/.bin:${PATH}" BOX_IMAGE="outfitter/${BOX_APP}-box:dev"
RUN mkdir -p /box /in /out && chown -R node:node /box /out
USER node
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/.box/supervisor.mjs"]
