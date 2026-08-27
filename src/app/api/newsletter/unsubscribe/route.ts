import { createAdminClient } from "@/lib/supabase/admin";
import { unsubTokenValid } from "@/lib/newsletter";

/** GET ?u=<userId>&t=<token> — the link at the bottom of every
 *  newsletter. Public and login-free on purpose: consent must be easier
 *  to withdraw than it was to give, and "sign in to stop getting email"
 *  fails that test. The token is an HMAC of the user id, so the link
 *  works only for the inbox it was sent to.
 *
 *  Also answers POST identically: the List-Unsubscribe-Post header
 *  promises mail clients a one-click POST endpoint. */
async function unsubscribe(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const userId = url.searchParams.get("u") ?? "";
  const token = url.searchParams.get("t") ?? "";

  const page = (title: string, body: string, status = 200) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${title}</title>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#16171B">` +
        `<h1 style="font-size:1.3rem">${title}</h1><p style="line-height:1.6;color:#555">${body}</p></body>`,
      { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );

  if (!userId || !token || !unsubTokenValid(userId, token)) {
    return page(
      "That link didn't work",
      "The unsubscribe link looks incomplete or expired. You can always turn the newsletter off from Account settings inside TCGdeck.",
      400
    );
  }
  try {
    const admin = createAdminClient();
    await admin.from("profiles").update({ newsletter_opt_in: false }).eq("id", userId);
  } catch {
    return page(
      "Something went wrong",
      "We couldn't update your preference just now — try the link again in a minute, or turn the newsletter off from Account settings.",
      500
    );
  }
  return page(
    "You're unsubscribed",
    "No more newsletters to this address. If you change your mind, the toggle lives in TCGdeck's Account settings."
  );
}

export async function GET(req: Request) {
  return unsubscribe(req);
}

export async function POST(req: Request) {
  return unsubscribe(req);
}
