-- Remember what a card used to be worth.
--
-- Every price write updates cards.market_price and cards.prices in place, so
-- yesterday's number is gone the moment tonight's arrives. That makes some
-- fair questions unanswerable: is this card climbing or sliding, was the
-- collection worth more last month, did the set rotation move anything, is
-- now a reasonable moment to grade or sell.
--
-- A TRIGGER rather than application code, because prices are written from
-- more places than any one call site knows about: the nightly cron, the
-- admin refresh button, the per-collection refresh, the PokeTrace lookups,
-- the fill-the-gaps sweep after a scan, and the import tools. Instrumenting
-- each of those would have missed one today and two more next month. The
-- database sees them all.
--
-- One row per card per day, last write of the day winning. Prices don't move
-- meaningfully within a day and a chart wants a clean series, so this is the
-- right grain — and the primary key makes a re-run of a night's refresh
-- update the row rather than pile on duplicates.
--
-- Only on CHANGE. A card whose price held steady for a month is one row and
-- one date, which is what a step-function chart wants anyway. The cost of
-- this table is bounded by how much prices actually move.

create table if not exists public.card_price_history (
  card_id text not null references public.cards (id) on delete cascade,
  on_date date not null default current_date,
  market_price numeric,
  prices jsonb,
  primary key (card_id, on_date)
);

-- Reading a card's own series, newest first, is the only query this serves.
create index if not exists card_price_history_card_idx
  on public.card_price_history (card_id, on_date desc);

alter table public.card_price_history enable row level security;

-- Same shape as cards itself: shared reference data, readable by anyone
-- signed in. No write policies at all — the trigger runs as its definer and
-- nothing else should ever insert here.
drop policy if exists "price history viewable" on public.card_price_history;
create policy "price history viewable"
  on public.card_price_history for select to authenticated using (true);

create or replace function public.snapshot_card_price()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.market_price is distinct from old.market_price
     or new.prices is distinct from old.prices then
    insert into public.card_price_history (card_id, on_date, market_price, prices)
    values (new.id, current_date, new.market_price, new.prices)
    on conflict (card_id, on_date) do update
      set market_price = excluded.market_price,
          prices = excluded.prices;
  end if;
  return new;
end;
$$;

drop trigger if exists cards_price_history on public.cards;
create trigger cards_price_history
  after update on public.cards
  for each row execute function public.snapshot_card_price();

-- Today's prices as the first point. Without it the earliest history a card
-- can have is its next CHANGE, so a card that holds steady for six weeks
-- would show nothing at all until it moved — and the chart would be blank
-- on exactly the cards that were stable.
insert into public.card_price_history (card_id, on_date, market_price, prices)
select id, current_date, market_price, prices
from public.cards
where market_price is not null or prices is not null
on conflict (card_id, on_date) do nothing;

comment on table public.card_price_history is
  'One row per card per day, written by a trigger on cards whenever a price changes.';
