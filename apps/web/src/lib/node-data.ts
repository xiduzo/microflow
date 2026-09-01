// The one path from "a node type plus a patch of config fields" to a complete,
// schema-valid node `data` object: the type's registry defaults, the patch on
// top, validated by the node's own zod schema. Ask AI writes through it
// (`lib/ai/flow-tools.ts`) and the built-in templates are authored with it
// (`lib/templates`), so neither can ship data the node itself would reject.

import { NODE_REGISTRY } from "@/components/flow/nodes/_REGISTRY";
import type { ComponentType } from "@/components/flow/nodes/_base/_base.types";

/**
 * Resolve a node's `data` from its type's `defaults` plus a partial `patch`
 * (optionally on top of an existing node's `base` data), validated against the
 * node's own schema.
 *
 * The caller may send just the field it cares about and still get a complete,
 * schema-valid node — the same thing the node picker does when you place one by
 * hand.
 */
export function resolveNodeData(
  type: ComponentType,
  patch: Record<string, unknown>,
  base?: Record<string, unknown>,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const { defaults, schema } = NODE_REGISTRY[type];
  const merged = { ...defaults, ...base, ...patch };
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `invalid data for ${type} — ${issues}` };
  }
  // Presentation keys (label/icon/group/…) live on `defaults` but not in the
  // schema, so keep the merged object and let the parsed one only prove it is
  // valid — dropping them would strip the node's own label off the canvas.
  return { ok: true, data: { ...merged, ...(parsed.data as Record<string, unknown>) } };
}
