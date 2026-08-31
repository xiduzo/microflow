// Shared lazy loader for the wasm-pack modules (runtime / firmata / codegen).
// Each generated glue exposes a default `init`; a surface module makes one
// loader and every entry point awaits it first. Concurrent callers share the
// single in-flight promise, so a module is fetched and compiled only once.

/** Make the lazy once-only initialiser for one wasm module. */
export function lazyWasmInit(
  init: (options: { module_or_path: string }) => Promise<unknown>,
  wasmUrl: string,
): () => Promise<unknown> {
  let initPromise: Promise<unknown> | null = null;
  return () => (initPromise ??= init({ module_or_path: wasmUrl }));
}
