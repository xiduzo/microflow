import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@microflow/db";
import { user } from "@microflow/db/schema/auth";
import { userSettings } from "@microflow/db/schema/user-settings";
import { protectedProcedure, router } from "../index";

// Animal icons from Lucide
export const COLLAB_ICONS = [
  "Bird",
  "Bug",
  "Cat",
  "Dog",
  "Fish",
  "Rabbit",
  "Rat",
  "Snail",
  "Squirrel",
  "Turtle",
  "Worm",
] as const;

export type CollabIcon = (typeof COLLAB_ICONS)[number];

const uid = () => Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

export const profileRouter = router({
  /**
   * Get current user's profile with settings
   */
  get: protectedProcedure.query(async ({ ctx }) => {
    const profile = await db.query.user.findFirst({
      where: eq(user.id, ctx.session.user.id),
      columns: {
        id: true,
        name: true,
        email: true,
        image: true,
      },
    });

    if (!profile) {
      throw new Error("User not found");
    }

    let settings = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, ctx.session.user.id),
    });

    // Create default settings if they don't exist
    if (!settings) {
      const id = uid();
      await db.insert(userSettings).values({
        id,
        userId: ctx.session.user.id,
      });
      settings = await db.query.userSettings.findFirst({
        where: eq(userSettings.userId, ctx.session.user.id),
      });
    }

    return {
      ...profile,
      settings: {
        collabColor: settings?.collabColor ?? "#6366f1",
        collabIcon: settings?.collabIcon ?? "Cat",
      },
    };
  }),

  /**
   * Update collaboration settings
   */
  updateCollab: protectedProcedure
    .input(
      z.object({
        collabColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        collabIcon: z.enum(COLLAB_ICONS).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Ensure settings exist
      let settings = await db.query.userSettings.findFirst({
        where: eq(userSettings.userId, ctx.session.user.id),
      });

      if (!settings) {
        const id = uid();
        await db.insert(userSettings).values({
          id,
          userId: ctx.session.user.id,
          collabColor: input.collabColor,
          collabIcon: input.collabIcon,
        });
      } else {
        await db
          .update(userSettings)
          .set({
            collabColor: input.collabColor,
            collabIcon: input.collabIcon,
          })
          .where(eq(userSettings.userId, ctx.session.user.id));
      }

      return { success: true };
    }),
});
