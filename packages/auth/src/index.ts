import { db } from "@microflow/db";
import * as schema from "@microflow/db/schema/auth";
import { env } from "@microflow/env/server";
import { polar, checkout, portal } from "@polar-sh/better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";

import { polarClient } from "./lib/payments";

const isDev = env.NODE_ENV === "development";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",

    schema: schema,
  }),
  trustedOrigins: [
    env.CORS_ORIGIN,
    // Tauri app origins
    "tauri://localhost",
    "https://tauri.localhost",
    ...(isDev ? ["http://localhost:3001"] : []),
  ],
  advanced: {
    defaultCookieAttributes: {
      // Use 'lax' in dev for Tauri compatibility, 'none' in production
      sameSite: isDev ? "lax" : "none",
      secure: !isDev,
      httpOnly: true,
    },
  },
  plugins: [
    emailOTP({
      async sendVerificationOTP({ email, otp }) {
        // TODO: replace with your email provider (e.g. Resend, Nodemailer)
        console.log(`[OTP] ${email} → ${otp}`);
      },
    }),
    polar({
      client: polarClient,
      createCustomerOnSignUp: true,
      enableCustomerPortal: true,
      use: [
        checkout({
          products: [
            {
              productId: "your-product-id",
              slug: "pro",
            },
          ],
          successUrl: env.POLAR_SUCCESS_URL,
          authenticatedUsersOnly: true,
        }),
        portal(),
      ],
    }),
  ],
});
