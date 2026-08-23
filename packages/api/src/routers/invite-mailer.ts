import type { InviteMailer } from "@microflow/db/flow-invitation";
import { sendEmail } from "@microflow/auth/email";
import { env } from "@microflow/env/server";

/**
 * Production `InviteMailer`: renders the invite notice and sends it via
 * Resend. The wording is the only thing that differs between a grant and a
 * pending invite, so both live here rather than in the invitation module.
 */
export const resendInviteMailer: InviteMailer = async (notice) => {
  const webUrl = env.WEB_URL ?? env.CORS_ORIGINS[0];
  const flowUrl = `${webUrl}/flow/${notice.flowId}`;

  if (notice.kind === "pending") {
    const signupUrl = `${webUrl}/login?redirect=${encodeURIComponent(`/flow/${notice.flowId}`)}`;
    await sendEmail({
      to: notice.to,
      subject: `${notice.invitedBy} invited you to a flow on Microflow`,
      html: `<p>${notice.invitedBy} invited you to collaborate on "${notice.flowName}" as a <strong>${notice.role}</strong>.</p><p><a href="${signupUrl}">Sign up to open it</a> — you'll get access automatically.</p>`,
    });
    return;
  }

  await sendEmail({
    to: notice.to,
    subject: `${notice.invitedBy} shared a flow with you on Microflow`,
    html: `<p>${notice.invitedBy} added you as a <strong>${notice.role}</strong> on "${notice.flowName}".</p><p><a href="${flowUrl}">Open the flow</a></p>`,
  });
};
