import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { anthropic, MODEL } from "@/lib/anthropic";
import { requireUser, AuthError } from "@/lib/auth";
import { logAiUsage } from "@/lib/usage";

export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

const IMAGE_URL_RE = /https?:\/\/[^\s"'<>)\]]+\.(?:png|jpe?g|webp)(?:\?[^\s"'<>)\]]*)?/gi;

const SYSTEM = `You find official card scans for Pokémon TCG cards using web
search. Given a card's name, set, and collector number, search for a direct
image file of that EXACT card (matching number and set — not just any printing
of the Pokémon). Prefer reputable card-database sites.

Respond with ONLY direct image file URLs (ending in .png, .jpg, .jpeg, or
.webp), one per line, best match first, at most 5. No commentary, no page
URLs. If you cannot find the exact card, respond with the single word NONE.`;

/** POST: search the web for the card's image, store a copy in our bucket,
 *  and set it as the card's art. Only for cards the user owns a copy of. */
export async function POST(_req: Request, { params }: Params) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const supabase = await createClient();

    const [{ data: owned }, { data: card }] = await Promise.all([
      supabase
        .from("collection_items")
        .select("id")
        .eq("user_id", user.id)
        .eq("card_id", id)
        .limit(1)
        .maybeSingle(),
      // select("*") rather than naming columns: image_locked only exists
      // after migration 007, and a missing column would fail the whole
      // lookup (surfacing as a bogus "not in your collection" error).
      supabase.from("cards").select("*").eq("id", id).maybeSingle(),
    ]);
    if (!owned || !card) {
      return NextResponse.json(
        { error: "You can only find images for cards in your collection." },
        { status: 403 }
      );
    }
    if (card.image_locked) {
      return NextResponse.json(
        { error: "This card's image was set by the admin and can't be replaced." },
        { status: 409 }
      );
    }

    const client = anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
      messages: [
        {
          role: "user",
          content: `Find the card image: "${card.name}" — set: ${card.set_name}, collector number: ${card.number}${card.rarity ? `, rarity: ${card.rarity}` : ""}.`,
        },
      ],
    });

    await logAiUsage(supabase, user.id, "find_image", MODEL, response.usage);

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    const urls = [...new Set(text.match(IMAGE_URL_RE) ?? [])].slice(0, 5);
    if (urls.length === 0) {
      return NextResponse.json(
        { error: "Couldn't find an image for this exact card online — try adding your own photo." },
        { status: 404 }
      );
    }

    // Download the best candidate we can validate, then store OUR OWN copy —
    // hotlinked images rot and many CDNs block cross-site embedding.
    for (const url of urls) {
      try {
        const imgRes = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
            Accept: "image/*",
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!imgRes.ok) continue;
        const contentType = imgRes.headers.get("content-type") ?? "";
        if (!contentType.startsWith("image/")) continue;
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        if (buffer.length < 5_000 || buffer.length > 8_000_000) continue; // skip icons & monsters

        const admin = createAdminClient();
        const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
        const path = `${user.id}/web-${id.replace(/[^a-zA-Z0-9-]/g, "_")}-${Date.now()}.${ext}`;
        const { error: uploadErr } = await admin.storage
          .from("card-photos")
          .upload(path, buffer, { contentType, upsert: true });
        if (uploadErr) continue;
        const publicUrl = admin.storage.from("card-photos").getPublicUrl(path).data.publicUrl;

        const { error: updateErr } = await supabase
          .from("cards")
          .update({ image_small: publicUrl, image_large: publicUrl })
          .eq("id", id);
        if (updateErr) throw updateErr;

        // Keep as a candidate for admin review (best-effort)
        await supabase
          .from("card_image_candidates")
          .upsert(
            { card_id: id, url: publicUrl, uploaded_by: user.id },
            { onConflict: "card_id,url", ignoreDuplicates: true }
          )
          .then(() => {});

        return NextResponse.json({ imageUrl: publicUrl });
      } catch {
        continue; // try the next candidate
      }
    }

    return NextResponse.json(
      { error: "Found candidates but none could be downloaded — try adding your own photo." },
      { status: 404 }
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("find-image error", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Image search failed" },
      { status: 500 }
    );
  }
}
