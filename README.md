# PokéDeck 🔴⚪

Scan your Pokémon cards with your phone camera, track your collection (with values),
and build battle decks with Claude — solo or with friends.

## Features

- **📷 Camera scanning** — snap one card *or a whole spread*; Claude vision reads each
  card's name and collector number and matches it against the pokemontcg.io database.
- **✅ Review before saving** — every scan lands in an editable review grid with
  confidence flags. Fix any misidentification with a live database search, adjust
  quantities, then confirm.
- **🗂 Collection** — auto-tagged with Pokémon name, energy type, card type
  (Pokémon/Trainer/Energy), rarity (incl. Special Illustration Rare etc.), and set
  (e.g. *Perfect Order*). Search and filter by any of these. Duplicate scans merge
  into quantities.
- **💰 Value tracking** — best-effort TCGplayer market prices per card + total
  collection value, with a refresh button.
- **🤖 Deck builder** — Claude builds legal 60-card decks from cards you actually own,
  tailored to your saved play-style profile.
- **🔗 Claude Cowork** — a bundled skill (`.claude/skills/pokemon-deck-builder/`) plus a
  token-secured export API let you build decks by chatting with Claude anywhere.
- **👥 Accounts & admin** — magic-link login, invite-only signup, and an admin portal
  to invite friends and manage users. The first person to sign in becomes admin.

## Stack

Next.js (App Router, TypeScript) · Supabase (Postgres + Auth + RLS) · Anthropic API
(vision scanning + deck building) · pokemontcg.io (card database + prices) · Tailwind.

## Setup

### 1. Supabase (free tier is fine)

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run `supabase/migrations/001_init.sql`.
3. In **Authentication → URL Configuration**, set the Site URL to your app URL and add
   `https://<your-app>/auth/callback` to the redirect allow-list.
4. Grab from **Project Settings → API**: the project URL, `anon` key, and
   `service_role` key.

### 2. Anthropic

Create an API key at [console.anthropic.com](https://console.anthropic.com). Scanning
costs roughly a cent or two per photo; deck builds a few cents each.

### 3. (Optional) pokemontcg.io key

Free key at [dev.pokemontcg.io](https://dev.pokemontcg.io) — raises lookup rate limits.

### 4. Run it

```bash
cp .env.example .env.local   # fill in the values
npm install
npm run dev
```

Open http://localhost:3000, enter your email, click the magic link — **the first
account created becomes the admin**. Invite friends from the Admin page.

### 5. Deploy (Vercel)

Push to GitHub → import in Vercel → add the same env vars (set
`NEXT_PUBLIC_APP_URL` to your production URL) → deploy. Update the Supabase redirect
allow-list with the production `/auth/callback` URL.

## Using the Cowork deck-builder skill

1. In the app: **Decks → Build decks in Claude Cowork → Show my collection link**.
2. In Claude Cowork, add this repo (the skill is auto-discovered) or copy
   `.claude/skills/pokemon-deck-builder/` into your skills folder.
3. Ask Claude to "build me a Pokémon deck" and paste your collection link when asked.

## Scanning tips

- Lay cards flat, no overlap, decent light, minimal glare.
- Keep the collector number (e.g. `042/191`) readable — it's the strongest ID signal.
- Holo/reverse-holo finish of a physical copy isn't tracked (it's often not printed on
  the card); rarity like *Special Illustration Rare* is tracked automatically.

## Notes

- `ANTHROPIC_MODEL` defaults to `claude-opus-5`; override in env if desired.
- The collection export link grants read-only access to your collection list — treat
  it like a password.
