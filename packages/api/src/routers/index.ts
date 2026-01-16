import { protectedProcedure, publicProcedure, router } from "../index";
import { flowRouter } from "./flow";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  privateData: protectedProcedure.query(({ ctx }) => {
    return {
      message: "This is private",
      user: ctx.session.user,
    };
  }),
  flow: flowRouter,
});
export type AppRouter = typeof appRouter;
