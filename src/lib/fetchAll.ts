/** Supabase/PostgREST caps every response at 1,000 rows no matter what
 *  .limit() asks for — larger "limits" silently truncate, which made
 *  collections past 1,000 cards lose rows from search, deck building,
 *  exports, and price refreshing. This pages with .range() until done.
 *
 *  `build` must return a FRESH query each call (builders are single-use),
 *  and that query MUST have a total order — an ordering with ties isn't
 *  stable between requests, so tied rows can repeat on one page and vanish
 *  from another. Add `.order("id")` after the sort you actually want.
 *
 *  Pages after the first are fetched a few at a time IN PARALLEL. The
 *  sequential loop made a 4,000-row collection cost four full round trips
 *  end to end — most of the "seconds to see my cards" a big collection
 *  paid. The first page still goes alone (most reads fit in it and pay
 *  nothing extra); past that, a batch costs one round trip instead of
 *  three, at worst over-asking one empty page beyond the end. Results are
 *  appended in page order, so the total order the caller established is
 *  preserved exactly as before. */
export async function fetchAllRows<T>(
  build: () => {
    range: (
      from: number,
      to: number
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
  maxRows = 20000
): Promise<{ data: T[]; error: { message: string } | null }> {
  const PAGE = 1000;
  const BATCH = 3;

  const first = await build().range(0, PAGE - 1);
  if (first.error) return { data: [], error: first.error };
  const all: T[] = [...(first.data ?? [])];
  if (!first.data || first.data.length < PAGE) return { data: all, error: null };

  for (let from = PAGE; from < maxRows; ) {
    const starts: number[] = [];
    while (starts.length < BATCH && from < maxRows) {
      starts.push(from);
      from += PAGE;
    }
    const results = await Promise.all(starts.map((s) => build().range(s, s + PAGE - 1)));
    let done = false;
    for (const r of results) {
      if (r.error) return { data: all, error: r.error };
      all.push(...(r.data ?? []));
      if (!r.data || r.data.length < PAGE) done = true;
    }
    if (done) break;
  }
  return { data: all, error: null };
}
