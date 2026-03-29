FROM oven/bun:1

WORKDIR /app

# Copy workspace files so Bun workspaces can resolve packages
COPY bun.lock package.json turbo.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

# Install dependencies for the whole monorepo (use lockfile)
RUN bun install --frozen-lockfile

# Build the documentation site
WORKDIR /app/apps/fumadocs
RUN bun run build

ENV NODE_ENV=production
EXPOSE 4000

# Run the Next.js app on port 4000
CMD ["bun", "run", "start", "--", "-p", "4000", "-H", "0.0.0.0"]
