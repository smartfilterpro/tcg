import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser, AuthError } from "@/lib/auth";
import { artSrc } from "@/lib/art";

/** Alternate spellings a deck entry's name might be stored under in the
 *  cards table — chiefly basic energy: decks often say "Basic Fighting
 *  Energy" while the card record is named "Fighting Energy" (or vice
 *  versa). */
function nameVariants(name: string): string[] {
  const out = [name];
  const stripped = name.replace(/^basic\s+/i, "").trim();
  if (stripped && stripped !== name) out.push(stripped);
  if (/energy$/i.test(name) && !/^basic\s/i.test(name)) out.push(`Basic ${name}`);
  return out;
}

/** GET ?ids=a,b,c and/or ?names=x,y — card images from the local cache,
 *  for deck displays. `images` is keyed by card id; `imagesByName` is keyed
 *  by the requested name (for deck entries that never matched a card id). */
export async function GET(req: Request) {
  try {
    await requireUser();
    const url = new URL(req.url);
    const idsParam = url.searchParams.get("ids") ?? "";
    const namesParam = url.searchParams.get("names") ?? "";
    const ids = [...new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 150);
    const names = [...new Set(namesParam.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 60);
    if (ids.length === 0 && names.length === 0) {
      return NextResponse.json({ images: {}, imagesByName: {} });
    }

    const supabase = await createClient();

    const images: Record<string, string | null> = {};
    if (ids.length > 0) {
      const { data, error } = await supabase
        .from("cards")
        .select("id, image_small")
        .in("id", ids);
      if (error) throw error;
      // Hotlinked cards go out as /art paths, which mirror on first view.
      for (const row of data ?? []) images[row.id] = artSrc(row.id, row.image_small);
    }

    const imagesByName: Record<string, string | null> = {};
    if (names.length > 0) {
      // One exact-match pass over every variant spelling, images only.
      const variants = [...new Set(names.flatMap(nameVariants))];
      const { data } = await supabase
        .from("cards")
        .select("id, name, image_small")
        .in("name", variants)
        .not("image_small", "is", null)
        .limit(200);
      const byLower = new Map<string, string>();
      for (const row of data ?? []) {
        const key = (row.name as string).toLowerCase();
        if (!byLower.has(key)) {
          byLower.set(key, artSrc(row.id as string, row.image_small as string)!);
        }
      }
      const unresolved: string[] = [];
      for (const name of names) {
        const hit = nameVariants(name)
          .map((v) => byLower.get(v.toLowerCase()))
          .find(Boolean);
        if (hit) imagesByName[name] = hit;
        else unresolved.push(name);
      }
      // Case-insensitive fallback for the stragglers (capped — each is a query).
      for (const name of unresolved.slice(0, 12)) {
        const clean = name.replace(/[%_,()]/g, " ").trim();
        if (!clean) continue;
        const { data: rows } = await supabase
          .from("cards")
          .select("id, image_small")
          .or(nameVariants(clean).map((v) => `name.ilike.${v}`).join(","))
          .not("image_small", "is", null)
          .limit(1);
        imagesByName[name] = rows?.[0]
          ? artSrc(rows[0].id as string, rows[0].image_small as string | null)
          : null;
      }
    }

    return NextResponse.json({ images, imagesByName });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}
