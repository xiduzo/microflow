import { initTRPC, TRPCError } from "@trpc/server";
import { CannotInviteSelf } from "@microflow/db/flow-invitation";

import type { Context } from "./context";
import { FlowAccessDenied } from "./routers/flow-access";
import { FlowLibraryNotFound } from "./routers/flow-library";

export const t = initTRPC.context<Context>().create();

export const router = t.router;

/**
 * The tRPC code for an error a module under the routers threw to say "no",
 * or `null` for anything else (which stays INTERNAL_SERVER_ERROR). Those
 * modules do not know about tRPC, and the websocket gate reads the same
 * `FlowAccessDenied`, so the translation lives here, once.
 */
function codeOf(cause: unknown): TRPCError["code"] | null {
  if (cause instanceof FlowAccessDenied) {
    return cause.kind === "not-found" ? "NOT_FOUND" : "FORBIDDEN";
  }
  if (cause instanceof FlowLibraryNotFound) return "NOT_FOUND";
  if (cause instanceof CannotInviteSelf) return "BAD_REQUEST";
  return null;
}

/** Report a refusal with its own code; the message is the module's, as thrown. */
const procedure = t.procedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    const code = codeOf(cause);
    if (code) throw new TRPCError({ code, message: result.error.message, cause });
  }
  return result;
});

export const publicProcedure = procedure;

export const protectedProcedure = procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
      cause: "No session",
    });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
    },
  });
});
