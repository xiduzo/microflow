import { protectedProcedure, publicProcedure, router } from "../index";
import { communityRouter } from "./community";
import { flowRouter } from "./flow";
import { profileRouter } from "./profile";
import { supportersRouter } from "./supporters";

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
  community: communityRouter,
  profile: profileRouter,
  supporters: supportersRouter,
});
export type AppRouter = typeof appRouter;
