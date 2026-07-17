import { env } from "@microflow/env/server";
import { Resend } from "resend";

const resend = new Resend(env.RESEND_API_KEY);

/**
 * Send a transactional email via Resend, using the configured EMAIL_FROM.
 * Throws on failure so callers can surface the error.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}) {
  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    ...opts,
  });
  if (error) {
    console.error("[email] Failed to send:", error);
    throw new Error("Failed to send email");
  }
}
