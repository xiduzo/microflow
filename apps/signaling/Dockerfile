# Build stage
FROM node:20-alpine AS builder

# Enable corepack for Yarn
RUN corepack enable

WORKDIR /app

# Copy workspace root files (needed for Yarn workspaces)
COPY package.json ./package.json
COPY yarn.lock ./yarn.lock
COPY .yarnrc.yml ./.yarnrc.yml
COPY .yarn/plugins ./.yarn/plugins

# Copy app package files
COPY apps/signaling/package.json ./apps/signaling/package.json
COPY apps/signaling/tsconfig.json ./apps/signaling/tsconfig.json

# Install dependencies (from workspace root)
RUN yarn install --frozen-lockfile

# Copy source files
COPY apps/signaling/index.ts ./apps/signaling/index.ts

# Build TypeScript
WORKDIR /app/apps/signaling
RUN yarn build

# Production stage
FROM node:20-alpine

# Enable corepack for Yarn
RUN corepack enable

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy workspace root files (needed for Yarn workspaces)
COPY package.json ./package.json
COPY yarn.lock ./yarn.lock
COPY .yarnrc.yml ./.yarnrc.yml
COPY .yarn/plugins ./.yarn/plugins

# Copy app package files
COPY apps/signaling/package.json ./apps/signaling/package.json

# Install production dependencies only (from workspace root)
RUN yarn install --frozen-lockfile --production && \
    yarn cache clean

# Set working directory to app
WORKDIR /app/apps/signaling

# Copy built files from builder
COPY --from=builder /app/apps/signaling/dist ./dist

# Change ownership to non-root user
RUN chown -R nodejs:nodejs /app

USER nodejs

# Expose port (default 4444, can be overridden with PORT env var)
EXPOSE 4444

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT || 4444}', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Run the application
CMD ["node", "dist/index.js"]
