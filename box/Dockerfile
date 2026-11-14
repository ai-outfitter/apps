# A sealed Outfitter app box. Build from the root of this repository, with a
# checkout of the platform (ai-outfitter/webapp) as the `webapp` build context:
#   docker build --build-context webapp=../webapp --build-arg BOX_APP=software-foundry \
#     -f box/Dockerfile -t outfitter/software-foundry-box:dev .
# BOX_APP names apps/<app>; that app's box driver (apps/<app>/box/driver.mjs)
# runs the requests, and its operational package is built from this checkout.
# Boxes: software-foundry, workshop.
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
# The platform lists and runs an app's documents from the metadata it generated at
# apps:build, which is the released app's. Replace the box app's GraphQL schema and
# documents with this checkout's too, so a document this checkout adds (graph_documents,
# graph_query, graph_mutate) is served as its package serves it.
COPY --from=app /apps/apps/${BOX_APP}/graph /tmp/graph
RUN node -e 'const fs=require("fs");const app=process.env.BOX_APP;for(const [file,source,parse] of [["graph-schemas.json","schema.graphql",false],["graph-documents.json","documents.json",true]]){const from="/tmp/graph/"+source;if(!fs.existsSync(from))continue;const path="src/generated/apps/"+file;const all=JSON.parse(fs.readFileSync(path,"utf8"));const text=fs.readFileSync(from,"utf8");all[app]=parse?JSON.parse(text):text;fs.writeFileSync(path,JSON.stringify(all,null,2));}'
RUN cd workspace/runtime && npm ci --omit=dev --no-audit --no-fund
# The box harness and the box app (its driver and the sources it uses), laid
# out as in this repository, inside the checkout so they resolve its modules.
COPY box /app/.box/box
COPY apps/${BOX_APP} /app/.box/apps/${BOX_APP}

FROM docker.io/library/node:24-bookworm-slim
# Chrome for the workspaces' browser MCP (chrome-devtools-mcp, installed with the
# runtime), as the webapp's workspace/runtime/Dockerfile installs it: agents
# capture the demo screenshots the Foundry's review requires for visual changes.
# Before ARG BOX_APP, so every box app shares these layers.
ARG CHROME_VERSION=154.0.8037.92
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git git-lfs python3 procps tini \
    curl unzip fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxkbcommon0 libxrandr2 && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" -o /tmp/chrome.zip \
  && mkdir -p /opt/chrome && unzip -q /tmp/chrome.zip -d /opt/chrome && rm /tmp/chrome.zip
ENV WORKSPACE_BROWSER_NO_SANDBOX=1 \
    CHROME_EXECUTABLE_PATH=/opt/chrome/chrome-linux64/chrome \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/chrome/chrome-linux64/chrome
ARG BOX_APP=software-foundry
# CAD tools belong to the sealed Workshop image, never the developer host.
RUN if [ "$BOX_APP" = workshop ]; then apt-get update && apt-get install -y --no-install-recommends openscad python3-venv && python3 -m venv /opt/cad && /opt/cad/bin/pip install --no-cache-dir trimesh==4.5.3 numpy==2.2.6 && rm -rf /var/lib/apt/lists/*; fi
ENV PATH="/opt/cad/bin:${PATH}" QT_QPA_PLATFORM=offscreen
COPY --from=forgejo /app/gitea/gitea /usr/local/bin/forgejo
COPY --from=rustfs /usr/bin/rustfs /usr/local/bin/rustfs
# The platform runs from its checkout through the local-organizations loader,
# which serves real app workers (the production Node build cannot dispatch apps).
COPY --from=build --chown=node:node /app /app
# The workspace runtime (pi and its tools), as the workspace image installs it.
COPY --from=build /app/workspace/runtime /opt/workspace
RUN if [ "$BOX_APP" = workshop ]; then mkdir -p /opt/workshop && cp /app/.box/apps/workshop/box/workspace/build.py /opt/workshop/build.py; fi
WORKDIR /app
ENV NODE_ENV=development PATH="/opt/workspace/node_modules/.bin:${PATH}" BOX_APP="${BOX_APP}" BOX_IMAGE="outfitter/${BOX_APP}-box:dev"
RUN mkdir -p /box /in /out && chown -R node:node /box /out
USER node
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/.box/box/supervisor.mjs"]
