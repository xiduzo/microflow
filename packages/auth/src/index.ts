import { db } from "@microflow/db";
import * as schema from "@microflow/db/schema/auth";
import { env } from "@microflow/env/server";
import { polar, checkout, portal } from "@polar-sh/better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";

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
          products: [],
          successUrl: env.POLAR_SUCCESS_URL,
          authenticatedUsersOnly: true,
        }),
        portal(),
      ],
    }),
  ],
});
