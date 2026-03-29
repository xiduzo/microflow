FROM oven/bun:1

WORKDIR /app

# Copy workspace files so Bun workspaces can resolve packages
COPY bun.lock package.json turbo.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

# Install dependencies for the whole monorepo (use lockfile)
RUN bun install --frozen-lockfile

# Build the web app
WORKDIR /app/apps/web
RUN bun run build

ENV NODE_ENV=production
EXPOSE 3001

# Serve the built Vite app
CMD ["bun", "run", "serve", "--", "--host", "0.0.0.0", "--port", "3001"]
