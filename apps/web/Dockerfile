# ---- Stage 1: compile the Rust -> WASM crates ----
# microflow-core is compiled to wasm three ways (codegen / firmata / runtime) and
# emitted into apps/web/src/lib/*/generated, which the Vite app imports. wasm-pack
# resolves the whole Cargo workspace, so the full repo is copied in. The wasm-pack
# invocations mirror the project's build:wasm scripts exactly (same CWD + relative
# paths) so --out-dir resolves identically to a local build. No bun here — its
# installer needs unzip (absent from rust:1); wasm-pack is called directly.
FROM rust:1 AS wasm
WORKDIR /app

# wasm toolchain — above the source COPY so it stays layer-cached across commits
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-pack --locked

# whole workspace: wasm-pack loads every member manifest during resolution
COPY . .

# emits apps/web/src/lib/{codegen,firmata,runtime}/generated
WORKDIR /app/apps/web
RUN wasm-pack build ../../crates/microflow-codegen-wasm --target web --out-dir ../../apps/web/src/lib/codegen/generated \
 && wasm-pack build ../../crates/microflow-firmata-wasm --target web --out-dir ../../apps/web/src/lib/firmata/generated \
 && wasm-pack build ../../crates/microflow-runtime-wasm --target web --out-dir ../../apps/web/src/lib/runtime/generated

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

# wasm already built above — run only the Vite bundle. `build:app` (= vite build)
# via `bun run` is the proven pattern that runs vite under the bun runtime.
WORKDIR /app/apps/web
RUN bun run build:app

ENV NODE_ENV=production
EXPOSE 3001

# Serve the built Vite app
CMD ["bun", "run", "serve", "--", "--host", "0.0.0.0", "--port", "3001"]
