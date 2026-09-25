import type { ComponentValue } from "@/lib/bindings/ComponentValue";

/** Render a runtime `ComponentValue` as a compact one-line string for the inspector. */
export function formatComponentValue(value: ComponentValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `[${value.map(formatComponentValue).join(", ")}]`;
  // The only remaining variant is the RGBA colour object.
  return `rgb(${value.r} ${value.g} ${value.b} / ${value.a})`;
}
