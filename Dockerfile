# DVAP — INTENTIONALLY VULNERABLE demo system. Never deploy or expose.
# Strip the package metadata (license, author, repository...) before the dependency install, so editing it does not invalidate the cached npm layer.
FROM node:22-slim AS manifest
WORKDIR /m
COPY package.json package-lock.json ./
RUN grep -v -E '^  "(license|author|repository|bugs|homepage)":' package.json > deps.json && mv deps.json package.json

FROM node:22-slim AS base
WORKDIR /app
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    DVAP_DATA_DIR=/data \
    HOST=0.0.0.0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=manifest /m/package.json /m/package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER node
CMD ["npx", "tsx", "src/entry/ledger.ts"]

# Everything needed to attack, scan and test the stack from inside Docker: Node tests plus the Python tooling.
FROM base AS tools
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make curl \
 && rm -rf /var/lib/apt/lists/*
COPY vitest.config.ts Makefile README.md ./
COPY test ./test
COPY tooling ./tooling
COPY docs ./docs
COPY hints ./hints
RUN chown -R node:node /app
USER node
ENV PYTHONDONTWRITEBYTECODE=1
CMD ["bash"]
