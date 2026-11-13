FROM oven/bun:1

WORKDIR /app

# Copy workspace files so Bun workspaces and Turbo can resolve packages
COPY bun.lock package.json turbo.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

# Install dependencies for the whole monorepo (use lockfile)
RUN bun install --frozen-lockfile

# Build the API server
WORKDIR /app/apps/server
RUN bun run build

ENV NODE_ENV=production
EXPOSE 3000

# Run migrations then start the server. `exec` makes bun PID 1: otherwise `sh`
# holds PID 1, ignores the SIGTERM a deploy sends, and the server is SIGKILLed
# after the grace period without saving live collaboration rooms. Runs the
# built file directly (what `bun run start` does) so no wrapper sits between.
CMD ["sh", "-c", "bun run ../../packages/db/src/migrate.ts && exec bun run dist/index.mjs"]
