import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    POLAR_ACCESS_TOKEN: z.string().min(1),
    POLAR_SUCCESS_URL: z.url(),
    POLAR_SUPPORTER_PRODUCT_ID: z.string().min(1).optional(),
    POLAR_DONATION_PRODUCT_ID: z.string().min(1).optional(),
    GITHUB_SPONSORS_TOKEN: z.string().min(1).optional(),
    GITHUB_SPONSORS_LOGIN: z.string().min(1).default("xiduzo"),
    CORS_ORIGINS: z.string().min(1).transform((s) => s.split(",")),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    RESEND_API_KEY: z.string().min(1),
    EMAIL_FROM: z.string().min(1),
    // Public web app origin, used to build links in outgoing emails
    // (e.g. flow share links). Optional; falls back to the first CORS origin.
    WEB_URL: z.url().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
