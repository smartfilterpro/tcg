-- Sealed product: booster boxes, Elite Trainer Boxes, tins, bundles.
--
-- Kept in its OWN tables rather than as a flag on cards, deliberately.
--
-- Every part of this app assumes a row in `cards` is a card: it has a
-- collector number, a finish, HP and attacks; it can go in a deck, be
-- graded, be scanned, and count toward finishing a set. A booster box has
-- none of those properties. Adding `is_sealed` to `cards` would mean
-- teaching the deck builder, the grader, the scanner, set completion, the
-- assistant's index and every value calculation to special-case it — and
-- the failure mode of missing one is a booster box appearing in somebody's
-- deck list.
--
-- Separate tables mean every existing card-shaped assumption stays true by
-- construction. Nothing that reads `cards` can ever see sealed product.
--
-- Two tables, the same split `cards` / `collection_items` already uses:
--   sealed_products — the shared catalogue, so two members holding the same
--                     ETB share one price lookup
--   sealed_items    — who owns how many

create table if not exists public.sealed_products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- booster_box | etb | tin | bundle | booster_pack | collection_box |
  -- blister | other. Text rather than an enum: this list will grow, and a
  -- new product type should not need a migration.
  kind text not null default 'other',
  set_name text,
  release_year int,
  image_url text,
  market_price numeric,
  price_updated_at timestamptz,
  -- Which source said so. Sealed pricing has no single authority the way
  -- cards do, so the answer is worth less without knowing where it came
  -- from.
  price_source text,
  created_at timestamptz not null default now()
);

-- One row per product name. Case-insensitive, because "Surging Sparks
-- Booster Box" and "surging sparks booster box" are the same box and two
-- rows would split everyone's collection the way the card duplicates did.
create unique index if not exists sealed_products_name_idx
  on public.sealed_products (lower(name));

create table if not exists public.sealed_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.sealed_products(id) on delete cascade,
  quantity int not null default 1 check (quantity > 0 and quantity <= 9999),
  -- sealed | opened | damaged. An opened box is worth a different amount
  -- from a sealed one, and someone who keeps both wants both rows.
  condition text not null default 'sealed',
  price_override numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sealed_items_owner_idx
  on public.sealed_items (user_id, product_id, condition);
create index if not exists sealed_items_user_idx on public.sealed_items (user_id);

alter table public.sealed_products enable row level security;
alter table public.sealed_items enable row level security;

-- The catalogue is readable by everyone signed in and written only by the
-- server (service role bypasses RLS) or an admin — same shape as `cards`.
-- A member adding a product they own goes through the API, which creates
-- the catalogue row on their behalf.
drop policy if exists "sealed products readable" on public.sealed_products;
create policy "sealed products readable"
  on public.sealed_products for select
  using (auth.role() = 'authenticated');

drop policy if exists "sealed products admin write" on public.sealed_products;
create policy "sealed products admin write"
  on public.sealed_products for all
  using (public.is_admin())
  with check (public.is_admin());

-- Your sealed items are yours.
drop policy if exists "own sealed items" on public.sealed_items;
create policy "own sealed items"
  on public.sealed_items for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Admins can see them for support, the same as collection_items.
drop policy if exists "admin reads sealed items" on public.sealed_items;
create policy "admin reads sealed items"
  on public.sealed_items for select
  using (public.is_admin());

comment on table public.sealed_products is
  'Shared catalogue of sealed product. Deliberately NOT in cards: nothing that reads cards should ever see a booster box.';
comment on table public.sealed_items is
  'Sealed product ownership, mirroring collection_items for cards.';
