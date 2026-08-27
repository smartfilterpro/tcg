import { requireAdmin, AuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { TRUSTED, type CompiledCard } from "@/lib/cardEffects";
import type { CardBattleData } from "@/lib/pokemontcg";
import { NextResponse } from "next/server";

// The whole catalogue's battle knowledge, as a file a person (or a model)
// can actually read.
//
// "Make battles work for every card" is three different jobs, and this
// export exists to tell them apart:
//   - cards with NO printed text on file → run the card-text sweep
//   - cards with text but NO compiled effects → run the effect compiler
//   - cards the compiler tried and wasn't sure about → the interesting
//     ones: each is a card whose printed effect the engine's language
//     can't yet say, and the export carries its text and the compiler's
//     own note about what stumped it, which is exactly what's needed to
//     extend the language.
//
// NDJSON, streamed: one line per card, one summary line at the end, so the
// file works at any catalogue size and pastes well in chunks.
//
// ?mode=gaps (default) exports only the problem cards. ?mode=all exports
// everything, compiled effects included.

export const maxDuration = 300;

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const mode = new URL(req.url).searchParams.get("mode") === "all" ? "all" : "gaps";
    const admin = createAdminClient();

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const counts = {
          cards: 0,
          exported: 0,
          noText: 0,
          textFailed: 0,
          uncompiled: 0,
          lowConfidence: 0,
          trusted: 0,
          notPlayable: 0,
        };
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        const PAGE = 1000;
        try {
          for (let from = 0; ; from += PAGE) {
            const { data, error } = await admin
              .from("cards")
              .select(
                "id, name, supertype, subtypes, types, hp, number, set_name, battle_data, effects, effects_v, text_attempts, text_failed_at"
              )
              .order("id")
              .range(from, from + PAGE - 1);
            if (error) throw error;
            const rows = data ?? [];
            for (const row of rows) {
              counts.cards += 1;
              const bd = (row.battle_data as CardBattleData | null) ?? null;
              const fx = (row.effects as CompiledCard | null) ?? null;
              const isPokemon = /pok/i.test((row.supertype as string | null) ?? "");
              // Cards with no game text at all (basic energy, most of the
              // supertype-less imports) have nothing to compile.
              const playable =
                isPokemon || (bd?.rules?.length ?? 0) > 0 || (row.supertype as string | null) != null;
              let status: string;
              if (!playable) {
                status = "not_playable";
                counts.notPlayable += 1;
              } else if (!bd) {
                status = (row.text_failed_at as string | null) ? "text_failed" : "no_text";
                counts[(row.text_failed_at as string | null) ? "textFailed" : "noText"] += 1;
              } else if (!fx) {
                status = "uncompiled";
                counts.uncompiled += 1;
              } else if ((fx.confidence ?? 0) < TRUSTED) {
                status = "low_confidence";
                counts.lowConfidence += 1;
              } else {
                status = "trusted";
                counts.trusted += 1;
              }

              const inGaps =
                status === "no_text" ||
                status === "text_failed" ||
                status === "uncompiled" ||
                status === "low_confidence";
              if (mode === "gaps" && !inGaps) continue;
              counts.exported += 1;
              send({
                  id: row.id,
                  name: row.name,
                  set: row.set_name,
                  number: row.number,
                  supertype: row.supertype,
                  subtypes: row.subtypes,
                  hp: row.hp,
                  status,
                  text: bd
                    ? {
                        attacks: bd.attacks,
                        abilities: bd.abilities,
                        rules: bd.rules,
                        stage: bd.stage,
                        evolvesFrom: bd.evolvesFrom,
                        weak: bd.weak,
                        resist: bd.resist,
                        retreat: bd.retreat,
                      }
                    : null,
                  ...(mode === "all" || status === "low_confidence"
                    ? { effects: fx }
                    : {}),
                  ...(fx?.note ? { compilerNote: fx.note } : {}),
              });
            }
            if (rows.length < PAGE) break;
          }
        } catch (err) {
          send({
            error: `export stopped early: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        // Summary LAST, like a trailer: streaming rows as they page keeps
        // memory flat at any catalogue size, and the last line is where a
        // reader (or a script) finds the triage totals — which sweep to run
        // before anything needs hand-reading at all.
        send({ summary: true, mode, generatedAt: new Date().toISOString(), ...counts });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="tcgdeck-battle-${mode}.ndjson"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }
}
