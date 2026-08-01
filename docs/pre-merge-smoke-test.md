# Pre-merge smoke test

~45 commits and nine migrations deep. This is the click-through that proves
the branch before it becomes production. Do it against a database copy, not
the live one — the point is to find a broken migration somewhere it doesn't
cost you anything.

Time: about 30 minutes. Anything that fails, stop and report it; a red line
here is far cheaper than the same line found by a member.

## 0. Setup

- [ ] Snapshot / branch the database (Supabase → Database → Backups, or a
      new project restored from a dump).
- [ ] Deploy the branch against that copy.
- [ ] Run migrations **031 → 039 in order**. Each should complete with no
      error; a later one failing usually means an earlier one was skipped.
- [ ] Sign in as admin. The site loads, the nav is intact.

## 1. The things that were rebuilt as jobs (sleep-proofing)

The whole point is surviving a dead connection, so test that, not just the
happy path.

- [ ] **Scan** a photo of 3+ cards. Mid-scan, **lock the phone** (or close
      the laptop lid) for ~30s. Unlock: progress continues, results arrive.
- [ ] **Grade** a card, front and back. Lock the phone mid-grade. Unlock:
      the report arrives. Centering shows a top-to-bottom ratio on a
      bordered card (that axis was 1-in-8 before, ~6-in-8 now).
- [ ] **Chat**: ask TrainerAI something. Lock mid-answer. Unlock: the answer
      is there, not "The chat failed".
- [ ] Reload the page mid-chat-answer — your question is still in the thread
      and the reply lands when ready.
- [ ] **Deck build**: build a deck; refresh the page while it builds; it
      resumes.

## 2. The AI surfaces

- [ ] TrainerAI: **"Does <a set you own> have a <card>?"** → it uses the
      catalogue, not a shrug.
- [ ] TrainerAI: **"What am I missing from <set>?"** → a real missing list,
      with a coverage caveat if the set isn't fully catalogued.
- [ ] TrainerAI: ask about a card you own several printings of → counts are
      right per set.
- [ ] Deck builder: **"build me a combo deck"** → a genuine combo deck, or
      a first sentence that says plainly it can't and why.
- [ ] Deck format picker: switching Standard / Expanded / Anything goes
      changes the explainer line under it.

## 3. Cards, search, images

- [ ] Card search by **"050"** and by **"50"** for the same card → both find
      it, and the exact-number card is at the top.
- [ ] Search a full card name → at least as many results as half the name.
- [ ] Collection totals line shows "N with no price yet" when applicable.
- [ ] Open a card whose art is still hotlinked → it renders, and reloading
      shows it now served from our storage (`/card-art/` in the URL).
- [ ] As a **non-admin** member, a card with no art shows the "arrives
      automatically" note — no photo-upload buttons.

## 4. Plans and money

- [ ] As a **free** member: save 3 decks, then try a 4th → refused with the
      upgrade route. Delete one → you can save again.
- [ ] As a free member: the deck share picker is a lock, and "Decks shared
      with you" shows the upgrade note.
- [ ] Upgrade a test account through Stripe checkout → on return, the plan
      shows immediately (no "already paid? refresh" dance).
- [ ] **Live-mode Stripe webhook** is registered for the production domain;
      the boost/upgrade lands credits.
- [ ] Out-of-credits state: a member at zero sees the lock, and the buttons
      route to pricing.

## 5. Admin

- [ ] Every tab loads: Analytics, Members, Content, Catalogue, Bulk scan,
      Support. Page is dark throughout.
- [ ] Analytics: margin tile shows a colour against the 55% target;
      "Needs a human" rows have working jump buttons.
- [ ] Members: reset name / block trades / block sharing / make admin all
      work, and you **cannot** change your own role.
- [ ] Content: rename and unshare a shared deck.
- [ ] Catalogue: price sync panel reports a sane credits-used figure
      (not 0 right after a run); held prices show the card picture with
      Apply / Keep.
- [ ] Trades board: as admin, "Remove (admin)" on someone else's post and
      ✕ on a reply.
- [ ] CSV loader: preview a small CSV against a test member, then load it,
      then confirm quantities merged rather than duplicated.

## 6. Bulk scan (the service)

- [ ] Create a job → device key and job id appear.
- [ ] Post two photos of the SAME card as pass 1 seq 1 and pass 2 seq 1
      (curl is fine) → Finalize → **1 verified, 0 for review**.
- [ ] Post two photos of DIFFERENT cards the same way → Finalize → that row
      lands in the review queue with both photos visible.
- [ ] Review it, accept or correct → Export CSV, then **Add to member**.
- [ ] **Undo upload** → the cards leave that member's collection.

## 7. Background jobs (check after ~20 minutes of uptime)

- [ ] Admin → Catalogue → Mirror card art: "N still hotlinked" is falling.
- [ ] Price sync panel: the set index advances without anyone pressing Sync.
- [ ] Railway logs show `art mirror:` and `price sync loop:` lines and no
      repeating errors.

## 8. Before you flip production

- [ ] Backups: Supabase → Database → Backups is on. Note that **storage
      buckets are not included** — member photos, grading photos and
      bulk-scan photos need their own copy.
- [ ] Terms page reads correctly, including the mail-in section.
- [ ] `POKEMONPRICETRACKER_EXPORTS` is `0` unless you've upgraded.
- [ ] No API keys anywhere but Railway env vars.
