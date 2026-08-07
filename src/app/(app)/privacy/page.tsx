import Link from "next/link";
import { APP_NAME, AI_NAME } from "@/lib/branding";

// The privacy policy.
//
// Written from what the code actually does, not from a template. Every claim
// below was checked against the routes and libraries that implement it —
// which is why it says that member card photos live at public URLs and that
// a slice of your collection is sent to Anthropic with an assistant
// question. A policy that describes a tidier app than the real one is worse
// than none: it is a promise nobody kept.
//
// Also a store requirement. Both Apple and Google refuse a submission
// without a live privacy policy URL, so this page is a prerequisite for
// #20 as much as it is the right thing to publish.

const EFFECTIVE_DATE = "August 5, 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-base font-bold">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="card-panel p-6 sm:p-8">
        <h1 className="text-2xl font-bold">{APP_NAME} — Privacy Policy</h1>
        <p className="mt-1 text-xs text-slate-400">Effective date: {EFFECTIVE_DATE}</p>

        <p className="mt-4 text-sm leading-relaxed text-slate-700">
          This policy describes what {APP_NAME} (the &ldquo;Service&rdquo;) collects, why, who
          else sees it, and how to get rid of it. It is written from what the application
          actually does rather than from a template, so where something is less private than
          you might assume — photographs stored at public web addresses, a summary of your
          collection sent to an AI provider — it says so plainly.
        </p>

        <Section title="1. Who is responsible">
          <p>
            {APP_NAME} is a small, invite-only hobby project operated by its administrator.
            There is no company behind it and no data is sold to anyone, ever. For any
            question about this policy or about your data, use the{" "}
            <Link href="/support" className="text-brand-accent underline">
              support page
            </Link>
            .
          </p>
        </Section>

        <Section title="2. What we collect">
          <p>
            <b>Your account.</b> Your email address and password, handled by our
            authentication provider — passwords are stored hashed and are never visible to us
            or to anyone else. Your display name, avatar initials, friend code, plan and role.
          </p>
          <p>
            <b>What you put in the app.</b> The cards in your collection with their
            quantities, finishes, notes and any custom values you set; sealed products; decks
            and deck notes; grading reports; battles; friends and friend requests; trade posts
            and trade messages; and your conversations with {AI_NAME}.
          </p>
          <p>
            <b>Photographs.</b> Card photos you take to scan, photographs you attach to a
            card, and the photos you submit for a grading report.
          </p>
          <p>
            <b>Usage records.</b> Each AI action records which feature was used, which model,
            how many tokens and what it cost, so credits can be metered honestly. Each scan
            records how long it took and how many cards were detected, matched and saved. We
            keep a short rolling window of server logs for diagnosing faults; these can
            contain card names and internal identifiers.
          </p>
          <p>
            <b>Payment records.</b> If you subscribe or buy credits, our payment processor
            holds your card details. We never see or store a card number. We store your
            customer and subscription identifiers, your plan, and what you were charged.
          </p>
          <p>
            We do not use advertising trackers, analytics pixels, or any third-party profiling
            of any kind. The only cookies set are the ones that keep you signed in.
          </p>
        </Section>

        <Section title="3. Photographs, and one thing worth knowing">
          <p>
            Photographs you upload as a card&apos;s picture are stored in a public storage
            bucket. The web address is long and effectively unguessable, and nothing in the
            app lists other people&apos;s photos — but anyone who has the address can open it
            without signing in. Do not photograph anything you would mind being seen: keep the
            card in the frame and your surroundings out of it.
          </p>
          <p>
            Photos submitted for grading and photos processed by the bulk scanner are stored
            privately and served through short-lived signed links.
          </p>
        </Section>

        <Section title="4. Who else sees your data">
          <p>
            <b>Our hosting and database providers</b> store everything above on our behalf.
          </p>
          <p>
            <b>Anthropic</b> processes AI requests. This means: photographs you scan or submit
            for grading; the questions you ask {AI_NAME} or the deck coach; and, for assistant
            questions, a summary of your collection and decks so the answer can be about your
            actual cards. Card photographs are also read by AI to transcribe what a card does
            when no card database describes it. Anthropic processes this to answer the request
            and does not use it to train its models.
          </p>
          <p>
            <b>Our payment processor</b> handles checkout, subscriptions and card details.
          </p>
          <p>
            <b>Card and price databases</b> — pokemontcg.io, TCGdex, Pokémon Price Tracker,
            PokeTrace and eBay — are asked about cards, not about you. They receive card names,
            numbers and set names. They are never sent your identity, your collection, or
            anything that could be linked back to you.
          </p>
          <p>
            We disclose data otherwise only where the law requires it. We do not sell or rent
            personal information, and there is nobody to sell it to.
          </p>
        </Section>

        <Section title="5. Family groups">
          <p>
            A family group lets one adult invite up to five members and set their AI usage
            caps. The organiser can see each member&apos;s usage and remaining credits, and can
            remove a member. They cannot read a member&apos;s {AI_NAME} conversations, and
            collections are visible to each other only through the app&apos;s ordinary sharing
            — friends, decks and trades — exactly as they would be between any two members.
          </p>
        </Section>

        <Section title="6. Children">
          <p>
            The Service is not intended for children under 13, and you must be 13 or older to
            hold an account. A younger person should not create one. If you are under the age
            of majority where you live, use the Service only with a parent or guardian&apos;s
            knowledge and consent — a family group is the intended way for a parent to set one
            up and keep an eye on it. If we learn that an account belongs to a child under 13,
            we will delete it and its data.
          </p>
        </Section>

        <Section title="7. How long we keep it">
          <p>
            Your data stays while your account exists. Deleting your account removes it: the
            account itself, your collection, decks, grading reports, battles, friends, trades,
            usage ledger and family memberships all go with it and are not recoverable.
          </p>
          <p>
            Two things survive deliberately and neither identifies you: the shared card
            catalogue, including any card record created because you scanned something the
            databases didn&apos;t have, and payment records our processor is required to keep
            for tax and accounting.
          </p>
        </Section>

        <Section title="8. Your choices">
          <p>
            <b>See it.</b> Everything in your collection is on screen, and the collection can
            be exported to a spreadsheet from the collection page.
          </p>
          <p>
            <b>Correct it.</b> Every card, quantity, finish, note and value is editable, and
            your account details are editable in Settings.
          </p>
          <p>
            <b>Delete it.</b> Settings → Account → Delete account, which tells you exactly how
            many cards, decks and reports are about to go, and then does it immediately. You do
            not have to ask us, and there is no waiting period.
          </p>
          <p>
            Depending on where you live you may have further rights over your personal data —
            to access it, correct it, export it, or have it erased. The three buttons above
            cover all of them; if you would rather ask, use the support page.
          </p>
        </Section>

        <Section title="9. Security">
          <p>
            Traffic is encrypted in transit. Database access is restricted per account so one
            member cannot read another&apos;s rows, and the writes that must not be tampered
            with — credits, family caps, moderation — are performed server-side only. No system
            is perfectly secure, and we would rather say that than imply otherwise.
          </p>
        </Section>

        <Section title="10. Changes">
          <p>
            If this policy changes in a way that affects what is collected or who sees it, the
            effective date above changes and the app will say so. Continuing to use the Service
            after that means the new policy applies.
          </p>
        </Section>

        <p className="mt-8 text-xs text-slate-400">
          See also the{" "}
          <Link href="/terms" className="underline">
            Terms of Service
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
