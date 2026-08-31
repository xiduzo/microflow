import { protectedProcedure, publicProcedure, router } from "../index";
import { communityRouter } from "./community";
import { discussionsRouter } from "./discussions";
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
  discussions: discussionsRouter,
  profile: profileRouter,
  supporters: supportersRouter,
});
export type AppRouter = typeof appRouter;
