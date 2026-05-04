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

ENV NODE_ENV=production

# HTTP transport: listen on all interfaces (override for stdio-only / other hosts)
ENV MCP_TRANSPORT=sse
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN groupadd --gid 1001 app \
  && useradd --uid 1001 --gid app --home /app --no-create-home --shell /usr/sbin/nologin app \
  && chown -R app:app /app

USER app

EXPOSE 3000

# Same as `npm start` in package.json (heap cap is a limit, not pre-allocation)
CMD ["node", "--max-old-space-size=28784", "--trace-warnings", "--experimental-specifier-resolution=node", "dist/index.js"]
