# ---- Stage 1: compile the Rust -> WASM crates ----
# microflow-core is compiled to wasm three ways (codegen / firmata / runtime) and
# emitted into apps/web/src/lib/*/generated, which the Vite app imports. This stage
# needs the full Cargo workspace (wasm-pack resolves every workspace member, incl.
# apps/web/src-tauri) and runs the project's own `build:wasm` scripts so they stay
# the single source of truth for what gets built and where.
FROM rust:1 AS wasm
WORKDIR /app

# wasm toolchain — kept above the source COPY so it stays layer-cached across commits
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-pack --locked

# bun, only to drive the project's build:wasm script chain
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# whole workspace: wasm-pack loads every member manifest during resolution
COPY . .

# emits apps/web/src/lib/{codegen,firmata,runtime}/generated
WORKDIR /app/apps/web
RUN bun run build:wasm

# ---- Stage 2: install JS deps, bundle the Vite app, serve ----
FROM oven/bun:1 AS web
WORKDIR /app

# Copy workspace files so Bun workspaces can resolve packages
COPY bun.lock package.json turbo.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

# Install dependencies for the whole monorepo (use lockfile)
RUN bun install --frozen-lockfile

# Reuse the WASM compiled in stage 1 — this image has no Rust toolchain
COPY --from=wasm /app/apps/web/src/lib/codegen/generated  ./apps/web/src/lib/codegen/generated
COPY --from=wasm /app/apps/web/src/lib/firmata/generated  ./apps/web/src/lib/firmata/generated
COPY --from=wasm /app/apps/web/src/lib/runtime/generated  ./apps/web/src/lib/runtime/generated

# Bundle only — wasm is already built above, so do NOT re-run build:wasm here.
# `--bun` runs vite under the bun runtime (no node in this image).
WORKDIR /app/apps/web
RUN bunx --bun vite build

ENV NODE_ENV=production
EXPOSE 3001

# Serve the built Vite app
CMD ["bun", "run", "serve", "--", "--host", "0.0.0.0", "--port", "3001"]
