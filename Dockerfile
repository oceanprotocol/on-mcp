# Build stage
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Runtime stage
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# HTTP transport: listen on all interfaces (override for stdio-only / other hosts)
ENV MCP_TRANSPORT=sse
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3000
ENV DOCS_CONTENT_DIR=/app/content

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY scripts ./scripts
COPY --from=builder /app/dist ./dist

RUN groupadd --gid 1001 app \
  && useradd --uid 1001 --gid app --home /app --no-create-home --shell /usr/sbin/nologin app \
  && chown -R app:app /app

USER app

EXPOSE 3000

# Sync docs content, then start the MCP server.
#
# `--import ./dist/telemetry/otel.js` bootstraps the OpenTelemetry SDK *before* express/http are
# imported (see docs/telemetry/README.md and the `start` script). Without it no MeterProvider is
# registered, every instrument is a silent no-op, and nothing is exported — telemetry env vars and
# MCP_TRANSPORT=sse notwithstanding. It self-disables on the stdio path, so it is always safe here.
CMD ["sh", "-lc", "node scripts/sync-docs-content.js && node --import ./dist/telemetry/otel.js --max-old-space-size=1536 --trace-warnings --experimental-specifier-resolution=node dist/index.js"]
