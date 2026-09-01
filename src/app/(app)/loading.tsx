/** Shown the moment a navigation starts, while the destination segment
 *  renders on the server. Without it a tap on a nav tab did nothing
 *  visible until the whole round trip finished — which on a phone read as
 *  the app ignoring the tap. A skeleton is not faster, but it is honest
 *  about being on the way. */
export default function Loading() {
  return (
    <div aria-busy="true" className="space-y-4">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-slate-200/70" />
      <div className="h-4 w-72 max-w-full animate-pulse rounded bg-slate-200/60" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="aspect-[63/88] animate-pulse rounded-lg bg-slate-200/50" />
        ))}
      </div>
    </div>
  );
}
