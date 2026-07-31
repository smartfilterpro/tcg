import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { anthropic, MODEL } from "@/lib/anthropic";
import { requireUser, AuthError } from "@/lib/auth";
import { logAiUsage } from "@/lib/usage";
import { checkCredits } from "@/lib/credits";
import { getTcgdexImageById } from "@/lib/tcgdex";
import { getCardById } from "@/lib/pokemontcg";
import { findCard, priceTrackerEnabled } from "@/lib/priceTracker";

export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

interface Candidate {
  url: string;
  source: string;
}

const IMAGE_URL_RE = /https?:\/\/[^\s"'<>)\]]+\.(?:png|jpe?g|webp)(?:\?[^\s"'<>)\]]*)?/gi;

const SYSTEM = `You find official card scans for Pokémon TCG cards using web
search. Given a card's name, set, and collector number, search for a direct
image file of that EXACT card (matching number and set — not just any printing
of the Pokémon). Prefer reputable card-database sites.

Respond with ONLY direct image file URLs (ending in .png, .jpg, .jpeg, or
.webp), one per line, best match first, at most 5. No commentary, no page
URLs. If you cannot find the exact card, respond with the single word NONE.`;

/** POST: search the web for the card's image, store a copy in our bucket,
 *  and set it as the card's art. Only for cards the user owns a copy of —
 *  except admins, who can pass { asAdmin: true } to find an image for any
 *  card (used by the review page); admin-found images are locked. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { user, profile } = await requireUser();
    // Admin-only, same rule as the manual photo endpoint: pictures come
    // from the pipeline or the admin, not from member uploads.
    if (profile?.role !== "admin") {
      return NextResponse.json(
        { error: "Card pictures are managed by the app now — tell the admin if one is wrong." },
        { status: 403 }
      );
    }
    const { id } = await params;
    const supabase = await createClient();

    const body = (await req.json().catch(() => ({}))) as { asAdmin?: boolean };
    const asAdmin = body?.asAdmin === true && profile?.role === "admin";

    const budget = await checkCredits(user, profile);
    if (!budget.ok) {
      return NextResponse.json({ error: budget.message }, { status: 429 });
    }

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
    if (!card || (!owned && !asAdmin)) {
      return NextResponse.json(
        { error: "You can only find images for cards in your collection." },
        { status: 403 }
      );
    }
    if (card.image_locked && !asAdmin) {
      return NextResponse.json(
        { error: "This card's image was set by the admin and can't be replaced." },
        { status: 409 }
      );
    }

    // Every rejection is recorded. "None could be downloaded" on its own is
    // not something anyone can act on — or reasonably believe.
    const attempts: string[] = [];
    const note = (url: string, why: string) => {
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* keep the raw string */
      }
      attempts.push(`${host}: ${why}`);
    };

    /** Download, validate, store our own copy, and point the card at it.
     *  Returns null if every candidate was rejected. We always keep a copy
     *  rather than saving someone else's link: hotlinked images rot and many
     *  CDNs block cross-site embedding. */
    async function tryCandidates(
      candidates: Candidate[]
    ): Promise<{ url: string; source: string } | null> {
      for (const { url, source } of candidates) {
        try {
          const imgRes = await fetch(url, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
              Accept: "image/*",
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (!imgRes.ok) {
            note(url, `HTTP ${imgRes.status}`);
            continue;
          }
          const contentType = imgRes.headers.get("content-type") ?? "";
          if (!contentType.startsWith("image/")) {
            note(url, `served ${contentType || "no content-type"}, not an image`);
            continue;
          }
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          if (buffer.length < 5_000) {
            note(url, `only ${buffer.length} bytes — too small to be a card scan`);
            continue;
          }
          if (buffer.length > 8_000_000) {
            note(url, `${Math.round(buffer.length / 1_000_000)}MB — too large`);
            continue;
          }

          const admin = createAdminClient();
          const ext = contentType.includes("png")
            ? "png"
            : contentType.includes("webp")
              ? "webp"
              : "jpg";
          const path = `${user.id}/web-${id.replace(/[^a-zA-Z0-9-]/g, "_")}-${Date.now()}.${ext}`;
          const { error: uploadErr } = await admin.storage
            .from("card-photos")
            .upload(path, buffer, { contentType, upsert: true });
          if (uploadErr) {
            note(url, `couldn't be saved to storage (${uploadErr.message})`);
            continue;
          }
          const publicUrl = admin.storage.from("card-photos").getPublicUrl(path).data.publicUrl;

          // Admin-found images lock, like every other admin image decision.
          // Retry without the lock flag on failure (pre-migration-007 DBs).
          let { error: updateErr } = await supabase
            .from("cards")
            .update({
              image_small: publicUrl,
              image_large: publicUrl,
              ...(asAdmin ? { image_locked: true } : {}),
            })
            .eq("id", id);
          if (updateErr && asAdmin) {
            ({ error: updateErr } = await supabase
              .from("cards")
              .update({ image_small: publicUrl, image_large: publicUrl })
              .eq("id", id));
          }
          if (updateErr) throw updateErr;

          // Keep as a candidate for admin review (best-effort) — but not when
          // the ADMIN ran the search: that's a final decision, and a candidate
          // row would pin the card in the review list forever.
          if (!asAdmin) {
            await supabase
              .from("card_image_candidates")
              .upsert(
                { card_id: id, url: publicUrl, uploaded_by: user.id },
                { onConflict: "card_id,url", ignoreDuplicates: true }
              )
              .then(() => {});
          }

          return { url: publicUrl, source };
        } catch (err) {
          note(url, err instanceof Error ? err.message.slice(0, 80) : "download failed");
        }
      }
      return null;
    }

    // 1) Ask the database this card came from. These cards were saved from a
    // search, and search results arrive as briefs — only the first few have
    // their details fetched, so a card can sit here with no picture while its
    // own source has had one all along. Free, and guaranteed to be the right
    // printing.
    const fromSource: Candidate[] = [];
    try {
      if (id.startsWith("tcgdex-")) {
        const img = await getTcgdexImageById(id);
        if (img) {
          fromSource.push({ url: img.large, source: "TCGdex" });
          fromSource.push({ url: img.small, source: "TCGdex" });
        }
      } else if (!id.startsWith("custom-")) {
        const primary = await getCardById(id);
        if (primary?.imageLarge)
          fromSource.push({ url: primary.imageLarge, source: "pokemontcg.io" });
        if (primary?.imageSmall)
          fromSource.push({ url: primary.imageSmall, source: "pokemontcg.io" });
      }
    } catch (err) {
      attempts.push(
        `source database: ${err instanceof Error ? err.message.slice(0, 80) : "unreachable"}`
      );
    }
    if (fromSource.length === 0) attempts.push("source database: has no image for this card");

    const direct = await tryCandidates(fromSource);
    if (direct) return NextResponse.json({ imageUrl: direct.url, source: direct.source });

    // 2) Pokémon Price Tracker — a real card database, paid but generously
    // budgeted, and tried BEFORE the AI search. Every card it finds is a
    // card that never reaches the expensive, guessing step below, and the
    // user is not charged credits for it.
    if (priceTrackerEnabled()) {
      try {
        const found = await findCard({
          name: (card.name as string) ?? "",
          setName: (card.set_name as string | null) ?? null,
          number: (card.number as string | null) ?? null,
        });
        // Free mapping: we were handed their catalogue id, and every bulk
        // dataset they publish joins on it. Best-effort — a card whose id we
        // fail to store is a card the backfill picks up later, not an error
        // worth failing an image search over.
        if (found?.tcgPlayerId) {
          await supabase
            .from("cards")
            .update({ tcgplayer_id: found.tcgPlayerId })
            .eq("id", id)
            .then(() => {});
        }
        if (found?.images.length) {
          const fromTracker = await tryCandidates(
            found.images.slice(0, 4).map((url) => ({ url, source: "Pokémon Price Tracker" }))
          );
          if (fromTracker) {
            return NextResponse.json({ imageUrl: fromTracker.url, source: fromTracker.source });
          }
        } else {
          attempts.push("Pokémon Price Tracker: no image for this card");
        }
      } catch (err) {
        attempts.push(
          `Pokémon Price Tracker: ${err instanceof Error ? err.message.slice(0, 80) : "failed"}`
        );
      }
    }

    // 3) Nothing usable from any card database, so search the web — which is
    // the point of the button. This runs whether the databases had no image
    // at all or had one that wouldn't download.
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
    const searched: Candidate[] = [...new Set(text.match(IMAGE_URL_RE) ?? [])]
      .slice(0, 5)
      .map((url) => ({ url, source: "web search" }));

    if (searched.length === 0) {
      return NextResponse.json(
        {
          error: `The web search turned up no direct image file for this exact printing (${attempts.join("; ")}). Upload your own photo instead.`,
          attempts,
        },
        { status: 404 }
      );
    }

    const found = await tryCandidates(searched);
    if (found) return NextResponse.json({ imageUrl: found.url, source: found.source });

    const tried = fromSource.length + searched.length;
    return NextResponse.json(
      {
        error: `Tried ${tried} image ${tried === 1 ? "source" : "sources"} and none worked — ${attempts.join("; ")}. Upload your own photo instead.`,
        attempts,
      },
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
