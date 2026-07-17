import { db } from "@microflow/db";
import * as schema from "@microflow/db/schema/auth";
import { flowInvite, flowCollaborator } from "@microflow/db/schema/flow";
import { env } from "@microflow/env/server";
import { eq } from "drizzle-orm";
import { polar, checkout, portal } from "@polar-sh/better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP } from "better-auth/plugins";

import { Resend } from "resend";

import { polarClient } from "./lib/payments";

const resend = new Resend(env.RESEND_API_KEY);

const isDev = env.NODE_ENV === "development";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",

    schema: schema,
  }),
  trustedOrigins: [
    ...env.CORS_ORIGINS,
    // Tauri app origins
    "tauri://localhost",
    "https://tauri.localhost",
    // Tauri v2 on Windows uses http://tauri.localhost (useHttpsScheme defaults to false)
    "http://tauri.localhost",
    ...(isDev ? ["http://localhost:3001"] : []),
  ],
  databaseHooks: {
    user: {
      create: {
        // When an invited email finally signs up, convert any pending flow
        // invites into real collaborator rows so they get access on first login.
        after: async (user) => {
          const invites = await db.query.flowInvite.findMany({
            where: eq(flowInvite.email, user.email),
          });
          if (invites.length === 0) return;
          for (const invite of invites) {
            await db.insert(flowCollaborator).values({
              id: crypto.randomUUID(),
              flowId: invite.flowId,
              userId: user.id,
              role: invite.role,
            });
          }
          await db.delete(flowInvite).where(eq(flowInvite.email, user.email));
        },
      },
    },
  },
  advanced: {
    defaultCookieAttributes: {
      // Use 'lax' in dev for Tauri compatibility, 'none' in production
      sameSite: isDev ? "lax" : "none",
      secure: !isDev,
      httpOnly: true,
    },
  },
  plugins: [
    bearer(),
    emailOTP({
      async sendVerificationOTP({ email, otp }) {
        const { error } = await resend.emails.send({
          from: env.EMAIL_FROM,
          to: email,
          subject: "Your Microflow sign-in code",
          html: `<p>Your sign-in code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`,
        });
        if (error) {
          console.error("[OTP] Failed to send:", error);
          throw new Error("Failed to send verification email");
        }
      },
    }),
    polar({
      client: polarClient,
      createCustomerOnSignUp: true,
      enableCustomerPortal: true,
      use: [
        checkout({
          products: [
            ...(env.POLAR_SUPPORTER_PRODUCT_ID
              ? [{ productId: env.POLAR_SUPPORTER_PRODUCT_ID, slug: "supporter" }]
              : []),
            ...(env.POLAR_DONATION_PRODUCT_ID
              ? [{ productId: env.POLAR_DONATION_PRODUCT_ID, slug: "donation" }]
              : []),
          ],
          successUrl: env.POLAR_SUCCESS_URL,
          authenticatedUsersOnly: true,
        }),
        portal(),
      ],
    }),
  ],
});
