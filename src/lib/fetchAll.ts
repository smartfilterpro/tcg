/** Supabase/PostgREST caps every response at 1,000 rows no matter what
 *  .limit() asks for — larger "limits" silently truncate, which made
 *  collections past 1,000 cards lose rows from search, deck building,
 *  exports, and price refreshing. This pages with .range() until done.
 *
 *  `build` must return a FRESH query each call (builders are single-use),
 *  and that query MUST have a total order — an ordering with ties isn't
 *  stable between requests, so tied rows can repeat on one page and vanish
 *  from another. Add `.order("id")` after the sort you actually want. */
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
  const all: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) return { data: all, error };
    all.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return { data: all, error: null };
}
