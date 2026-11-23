# Hello Po agent worker image for LiveKit Cloud.
# Build context is the repo root so the agent can use the shared workspace package.
FROM node:24-slim

# TLS roots for outbound calls to Deepgram, Groq and Supabase.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Install only what the agent needs (its deps + the shared workspace package).
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent/package.json apps/agent/
RUN npm ci --omit=dev --workspace @hello-po/agent --include-workspace-root=false

COPY packages/shared packages/shared
COPY apps/agent apps/agent

# Run as a non-root user.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser /app
USER appuser

# Node 24 runs TypeScript directly (type stripping), so there is no build step.
CMD ["node", "apps/agent/src/main.ts", "start"]
