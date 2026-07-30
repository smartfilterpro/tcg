import { APP_NAME } from "@/lib/branding";
const EFFECTIVE_DATE = "July 27, 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-base font-bold">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="card-panel p-6 sm:p-8">
        <h1 className="text-2xl font-bold">{APP_NAME} — Terms of Service</h1>
        <p className="mt-1 text-xs text-slate-400">Effective date: {EFFECTIVE_DATE}</p>

        <p className="mt-4 text-sm leading-relaxed text-slate-700">
          {APP_NAME} (the &ldquo;Service&rdquo;) is a private, invite-only hobby application for
          cataloging trading cards, building decks, and coordinating with other invited
          members. By creating an account, signing in, or using the Service in any way, you
          agree to these Terms of Service (the &ldquo;Terms&rdquo;). If you do not agree, do
          not use the Service.
        </p>

        <Section title="1. Eligibility and age requirement">
          <p>
            You must be at least <b>13 years old</b> to use the Service. If you are under the
            age of majority where you live (typically 18), you may only use the Service with
            the knowledge and consent of a parent or legal guardian, who agrees to these Terms
            on your behalf and accepts responsibility for your use, including any trades you
            arrange. By using the Service you represent that you meet these requirements. We
            may suspend or remove any account we believe does not.
          </p>
        </Section>

        <Section title="2. Accounts and access">
          <p>
            The Service is invite-only. You are responsible for keeping your password
            confidential and for everything that happens under your account. Tell the
            administrator immediately if you suspect unauthorized use. The administrator may
            suspend, limit (including AI usage limits), or delete any account at any time,
            with or without notice, for any reason. Deleting an account permanently removes
            its collection, decks, trades, and messages.
          </p>
        </Section>

        <Section title="3. No warranty — the Service is provided “as is”">
          <p>
            THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE,&rdquo; WITHOUT
            WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
            MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, AVAILABILITY, AND
            NON-INFRINGEMENT. The Service is a hobby project: it may be unavailable, change,
            lose data, or shut down at any time without notice. Keep your own records of
            anything important.
          </p>
        </Section>

        <Section title="4. No responsibility for data accuracy">
          <p>
            All information in the Service is provided for convenience and entertainment only
            and may be wrong. Without limiting that, we are not responsible for the accuracy
            of:
          </p>
          <ul className="list-inside list-disc space-y-1">
            <li>
              <b>Card identification.</b> Scanning uses artificial intelligence and third-party
              card databases; cards may be identified as the wrong card, set, printing, or
              finish (holo / reverse holo / stamped).
            </li>
            <li>
              <b>Prices and values.</b> Market prices come from third-party sources, may be
              stale or wrong, and are estimates — never a promise of what a card is worth or
              what it will sell or trade for. Nothing in the Service is financial, investment,
              or appraisal advice.
            </li>
            <li>
              <b>AI grading.</b> Grade estimates are produced by AI from photographs. They are
              not professional grades, do not predict what PSA, BGS, CGC, or any grader would
              assign, cannot verify authenticity, and must not be relied on for buying,
              selling, or trading decisions.
            </li>
            <li>
              <b>AI deck advice, trade advice, and chat.</b> TrainerAI output can be wrong,
              outdated, or misleading, including about card rules, legality, values, and trade
              fairness. Use your own judgment.
            </li>
            <li>
              <b>Analytics and statistics.</b> Usage, value totals, and scan statistics are
              best-effort estimates.
            </li>
          </ul>
        </Section>

        <Section title="5. Trades are entirely between users — at your own risk">
          <p>
            The Service lets members list, discuss, propose, and record card trades. The
            Service and its operator are <b>never a party to any trade</b>. We provide no
            escrow, do not verify cards, condition, authenticity, or ownership, do not
            guarantee that any trade will be completed, honored, or fair, and take no
            responsibility for any loss arising from a trade — including misrepresented,
            damaged, counterfeit, or undelivered cards. &ldquo;Accepting&rdquo; a trade in the
            app is a note between users, not a contract we enforce or supervise. Meet safely,
            inspect cards yourself, and trade only with people you trust. Any dispute about a
            trade is strictly between the users involved.
          </p>
        </Section>

        <Section title="6. Messages and user content">
          <p>
            Members can post trade listings, comments, messages, notes, deck names, photos,
            and usernames (&ldquo;User Content&rdquo;). User Content belongs to whoever posts
            it, and they are solely responsible for it. We do not pre-screen, monitor, or
            endorse User Content and accept <b>no responsibility for messages or other
            content exchanged between users</b>, including offensive, misleading, or unlawful
            content. You grant the Service the license needed to store and display your User
            Content to the members it is shared with. The administrator may remove any User
            Content at any time. Do not post content that is unlawful, harassing, hateful,
            sexually explicit, deceptive, infringing, or that shares another person&apos;s
            private information.
          </p>
        </Section>

        <Section title="7. Acceptable use">
          <ul className="list-inside list-disc space-y-1">
            <li>No attempting to access other members&apos; accounts or non-shared data.</li>
            <li>No scraping, reverse engineering, or disrupting the Service.</li>
            <li>No using the Service for commercial sales, spam, or advertising.</li>
            <li>No uploading malicious code or content you lack rights to.</li>
            <li>No abusing AI features (including attempts to bypass usage limits).</li>
          </ul>
        </Section>

        <Section title="8. Intellectual property">
          <p>
            Pokémon and all card names, images, and related marks are trademarks and
            copyrights of Nintendo, Creatures Inc., GAME FREAK inc., and The Pokémon Company
            International. {APP_NAME} is an <b>unofficial fan project</b> with no affiliation,
            sponsorship, or endorsement by those companies. Card data and images are provided
            by third-party databases for personal, non-commercial collection tracking only.
          </p>
        </Section>

        <Section title="9. Privacy">
          <p>
            The Service stores your email, username, collection, decks, trades, messages,
            photos you upload, support tickets, and usage statistics (including AI usage and
            estimated costs, visible to the administrator). Content you mark as shared —
            collections, decks, trade posts — is visible to other members. Photos and AI
            requests are processed by third-party providers (e.g. hosting, database, and AI
            services) to operate the Service. We do not sell your data. The administrator can
            see member emails and usage for running the Service.
          </p>
        </Section>

        <Section title="10. Payments, credits and refunds">
          <p>
            Paid plans and credit boosts are billed through Stripe. We never see or store your
            card details.
          </p>
          <p>
            <b>Payments are final.</b> Subscription charges and boost purchases are not
            refundable. You may cancel a subscription at any time and you keep access until the
            end of the billing period you have already paid for; cancelling part-way through a
            period does not produce a partial refund.
          </p>
          <p>
            Credits are a prepaid allowance for running AI features. They have no cash value,
            cannot be exchanged for money, and cannot be transferred to another account. Credits
            included with a subscription end when that subscription ends. Credits bought as a
            boost remain on your account and stay usable, including on the free plan. Deleting
            your account forfeits all remaining credits of either kind, and they are not
            reimbursed.
          </p>
          <p>
            A request that fails before it reaches the AI provider is not charged. A request that
            fails part-way through has already consumed the resources it is billed for, and that
            consumption is not refunded. We do not guarantee any particular result, grade,
            valuation, or deck from any request.
          </p>
          <p>
            Nothing in this section limits any rights you have under consumer law that cannot be
            waived by agreement. Where such rights apply, they apply regardless of the above.
          </p>
        </Section>

        <Section title="11. Limitation of liability">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SERVICE, ITS OPERATOR, AND
            ADMINISTRATORS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
            CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF DATA, PROFITS, CARDS, MONEY,
            OR GOODWILL, ARISING FROM OR RELATED TO YOUR USE OF THE SERVICE — INCLUDING
            INACCURATE DATA, AI OUTPUT, LOST OR CORRUPTED COLLECTION RECORDS, TRADES, USER
            CONTENT, OR SERVICE INTERRUPTION — EVEN IF ADVISED OF THE POSSIBILITY. TO THE
            EXTENT ANY LIABILITY CANNOT BE DISCLAIMED, TOTAL AGGREGATE LIABILITY IS LIMITED
            TO FIFTY U.S. DOLLARS (US$50) OR THE AMOUNT YOU PAID TO USE THE SERVICE IN THE
            PAST 12 MONTHS, WHICHEVER IS GREATER. Some jurisdictions do not allow certain
            limitations, so parts of this section may not apply to you.
          </p>
        </Section>

        <Section title="12. Indemnification">
          <p>
            You agree to defend, indemnify, and hold harmless the Service, its operator, and
            administrators from claims, damages, and expenses (including reasonable
            attorneys&apos; fees) arising from your User Content, your trades, your violation
            of these Terms, or your violation of any law or third-party right.
          </p>
        </Section>

        <Section title="13. Changes, suspension, and termination of the Service">
          <p>
            We may modify or discontinue any part of the Service at any time. We may update
            these Terms; when we do, you may be asked to accept the updated Terms to keep
            using the Service. Continued use after changes means you accept them.
          </p>
        </Section>

        <Section title="14. General">
          <p>
            These Terms are the entire agreement about the Service. If any provision is found
            unenforceable, the rest remain in effect. Failure to enforce a provision is not a
            waiver. These Terms are governed by the laws of the operator&apos;s place of
            residence, without regard to conflict-of-law rules, and disputes belong to the
            courts there. Questions? Open a ticket on the Help &amp; Support page.
          </p>
        </Section>

        <p className="mt-8 border-t border-slate-100 pt-4 text-xs text-slate-400">
          This document was drafted without legal counsel and is provided as a good-faith
          effort to set expectations for a private hobby service. For anything load-bearing,
          consult a lawyer.
        </p>
      </div>
    </div>
  );
}
