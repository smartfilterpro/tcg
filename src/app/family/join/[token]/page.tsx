import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { APP_NAME } from "@/lib/branding";
import JoinFamilyForm from "./JoinFamilyForm";

// The other end of a family invitation.
//
// Reachable signed out on purpose: the whole point of the change is that
// someone can be invited before they have an account. A visitor without one
// is sent to sign up and comes straight back here.

export const dynamic = "force-dynamic";

interface Invite {
  id: string;
  group_id: string;
  email: string;
  role: string;
  inviter_name: string;
  expires_at: string;
}

const SHELL = "mx-auto max-w-[34rem] px-4 py-12";
const PANEL = "rounded-[18px] border border-brand-line bg-white p-6";

export default async function JoinFamilyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createClient();

  // Security-definer lookup: returns nothing for an expired, answered or
  // revoked invitation, so a dead link and a wrong one look the same.
  //
  // The ERROR is a different thing entirely, and this used to throw it away.
  // A missing function, a database fault and a genuinely dead invitation all
  // rendered the same "isn't valid" — so the one failure a person could act
  // on was indistinguishable from the two they couldn't, and nobody could
  // tell which they were looking at. The same shape of bug as a card read
  // that never happened looking exactly like one that failed.
  const { data, error } = await supabase.rpc("family_invite_by_token", { t: token });
  const invite = (Array.isArray(data) ? data[0] : data) as Invite | undefined;

  if (error) {
    // Logged in full, because the visitor is not the person who can fix it.
    console.error(`family invite lookup failed: ${error.message}`);
  }

  if (!invite) {
    // Only the invitation itself is the visitor's business. A broken lookup
    // is ours, and saying "expired" about a database fault sends them to ask
    // for a new link that will fail in exactly the same way.
    const broken = !!error;
    const missingFunction = /family_invite_by_token|function|schema cache/i.test(
      error?.message ?? ""
    );
    return (
      <div className={SHELL}>
        <div className={PANEL}>
          <h1 className="m-0 mb-2 font-display text-2xl font-bold tracking-[-.025em]">
            {broken ? "We couldn\u2019t check this invitation" : "This invitation isn\u2019t valid"}
          </h1>
          <p className="m-0 text-[14.5px] leading-[1.6] text-brand-ink3">
            {broken ? (
              missingFunction ? (
                <>
                  Invitations need a one-time database update — run{" "}
                  <span className="font-mono text-[13px]">
                    supabase/migrations/031_family_invites.sql
                  </span>
                  . The link itself is fine and will work once that has run.
                </>
              ) : (
                <>
                  Something went wrong at our end, not with your link. Try again in a minute —
                  and if it keeps happening, tell whoever invited you so they can report it.
                </>
              )
            ) : (
              <>
                It may have expired, been cancelled, or already been answered. Ask whoever
                invited you to send a new one.
              </>
            )}
          </p>
          <Link href="/" className="mt-4 inline-block text-[14px] text-brand-accent underline">
            Go to {APP_NAME}
          </Link>
        </div>
      </div>
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className={SHELL}>
      <div className={PANEL}>
        <div className="font-mono text-[10.5px] uppercase tracking-[.1em] text-brand-ink5">
          Family invitation
        </div>
        <h1 className="m-0 mb-2 mt-1.5 font-display text-2xl font-bold tracking-[-.025em]">
          {invite.inviter_name} invited you to their {APP_NAME} family
        </h1>
        <p className="m-0 mb-4 text-[14.5px] leading-[1.6] text-brand-ink3">
          Sent to <span className="font-medium text-brand-ink2">{invite.email}</span> as a{" "}
          <span className="font-medium text-brand-ink2">
            {invite.role === "parent" ? "parent" : "kid"}
          </span>{" "}
          profile.
        </p>

        {/* Said plainly and before the button, not after. Joining hands real
            control over this account to someone else, and anyone agreeing to
            it should know exactly what they are agreeing to. */}
        <div className="mb-5 rounded-[14px] bg-brand-sunken p-4 text-[13.5px] leading-[1.6] text-brand-ink2">
          <p className="m-0 mb-2 font-semibold text-brand-ink">What joining means</p>
          <ul className="m-0 list-disc space-y-1 pl-5">
            <li>Your AI credits come from the family&apos;s shared monthly pool.</li>
            <li>
              A parent can set a monthly credit limit for you, and can see how much you&apos;ve
              used.
            </li>
            {invite.role !== "parent" && (
              <li>A parent can turn your trade board on or off, and you can&apos;t buy boosts.</li>
            )}
            <li>
              Your collection, decks and trades stay yours. You can leave at any time from
              Settings → Family.
            </li>
          </ul>
        </div>

        {user ? (
          <JoinFamilyForm
            token={token}
            invitedEmail={invite.email}
            signedInAs={user.email ?? ""}
          />
        ) : (
          <div>
            <p className="m-0 mb-3 text-[14px] leading-[1.6] text-brand-ink3">
              Sign in with <span className="font-medium text-brand-ink2">{invite.email}</span> to
              answer this — or create a free account with that address if you don&apos;t have one
              yet.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/login?next=${encodeURIComponent(`/family/join/${token}`)}`}
                className="rounded-full bg-brand-ink px-[18px] py-2.5 text-[13.5px] font-medium text-brand-canvas"
              >
                Sign in
              </Link>
              <Link
                href={`/signup?next=${encodeURIComponent(`/family/join/${token}`)}`}
                className="rounded-full border border-brand-line-strong px-[18px] py-2.5 text-[13.5px] font-medium"
              >
                Create a free account
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
