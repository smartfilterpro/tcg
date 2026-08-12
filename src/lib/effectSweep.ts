// Compiling the catalogue: printed text in, executable effects out.
//
// The companion to cardTextSweep. That one answers "what does this card
// say"; this one answers "what does that mean", and writes the answer into
// cards.effects where a battle can execute it without ever calling a model.
//
// One model call per card, once, ever — shared by every player because a
// card's rules do not vary by who holds it. The whole catalogue is a few
// dollars, paid once, against a model call per turn per battle forever if
// this were done live. That ratio is the entire argument for the design.
//
// Cheap model on purpose. This is a translation task with a closed output
// vocabulary and the printed text right there in the prompt — not a
// reasoning task. What it needs is care about saying "I'm not sure", which
// is why the schema makes confidence mandatory and the engine refuses to
// execute anything below TRUSTED.

import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropic } from "@/lib/anthropic";
import { askForJson } from "@/lib/aiJson";
import { logAiUsage } from "@/lib/usage";
import { EFFECT_SCHEMA_VERSION, type CompiledCard } from "@/lib/cardEffects";

/** Rows to look at per request. One indexed page. */
const SCAN_WINDOW = 300;

/** Cards compiled per batch. The only line here that costs money.
 *
 *  Higher than the text sweep's ten because this is text-in, text-out with
 *  no image: each call is small, fast and a fraction of a cent. Twenty
 *  finishes well inside the request timeout even when the API is slow. */
const COMPILE_PER_BATCH = 20;

const MODEL = "claude-haiku-4-5-20251001";

/** The closed vocabulary, as a schema.
 *
 *  Every `do` and `mod` the engine implements, and nothing else. A model
 *  that invents an opcode produces a card the engine silently skips, which
 *  is the worst outcome available — worse than `manual`, because `manual`
 *  at least tells the players to read the card. Enumerating here makes that
 *  unrepresentable rather than merely discouraged. */
const TARGETS = [
  "self",
  "myActive",
  "myBench",
  "myAll",
  "theirActive",
  "theirBench",
  "theirAll",
  "chosen",
];

const CONDITION = {
  type: "object",
  properties: {
    if: {
      type: "string",
      enum: [
        "always",
        "coinFlip",
        "damaged",
        "hasStatus",
        "isType",
        "energyAtLeast",
        "inPlay",
        "hpAtMost",
      ],
    },
    who: { type: ["string", "null"], enum: [...TARGETS, null] },
    status: { type: ["string", "null"] },
    type: { type: ["string", "null"] },
    name: { type: ["string", "null"] },
    side: { type: ["string", "null"], enum: ["mine", "theirs", "either", null] },
    n: { type: ["integer", "null"] },
  },
  required: ["if"],
  additionalProperties: false,
};

const ACTION = {
  type: "object",
  properties: {
    do: {
      type: "string",
      enum: [
        "damage",
        "heal",
        "status",
        "clearStatus",
        "draw",
        "discardHand",
        "millDeck",
        "searchDeckToHand",
        "searchDeckToBench",
        "shuffleHandIntoDeckDraw",
        "attachEnergyFromDiscard",
        "discardEnergy",
        "switch",
        "damageCounters",
        "manual",
      ],
    },
    who: { type: ["string", "null"], enum: [...TARGETS, null] },
    n: { type: ["integer", "null"] },
    status: { type: ["string", "null"] },
    what: { type: ["string", "null"] },
    side: { type: ["string", "null"], enum: ["mine", "theirs", null] },
    note: { type: ["string", "null"] },
  },
  required: ["do"],
  additionalProperties: false,
};

const CONDITIONAL = {
  type: "object",
  properties: {
    when: { anyOf: [CONDITION, { type: "null" }] },
    then: { type: "array", items: ACTION },
    otherwise: { type: ["array", "null"], items: ACTION },
  },
  required: ["then"],
  additionalProperties: false,
};

const MODIFIER = {
  type: "object",
  properties: {
    mod: {
      type: "string",
      enum: ["attackDamage", "damageTaken", "retreatCost", "maxHp", "noWeakness", "manual"],
    },
    who: { type: ["string", "null"], enum: [...TARGETS, null] },
    n: { type: ["integer", "null"] },
    when: { anyOf: [CONDITION, { type: "null" }] },
    note: { type: ["string", "null"] },
  },
  required: ["mod"],
  additionalProperties: false,
};

const SCHEMA = {
  type: "object",
  properties: {
    attacks: {
      type: ["array", "null"],
      description: "One entry per printed attack, in the same order.",
      items: {
        type: "object",
        properties: {
          bonus: { type: ["array", "null"], items: CONDITIONAL },
          effects: { type: ["array", "null"], items: CONDITIONAL },
        },
        additionalProperties: false,
      },
    },
    play: { type: ["array", "null"], items: CONDITIONAL },
    modifiers: { type: ["array", "null"], items: MODIFIER },
    provides: { type: ["array", "null"], items: { type: "string" } },
    confidence: { type: "number" },
    note: { type: ["string", "null"] },
  },
  required: ["confidence"],
  additionalProperties: false,
};

const SYSTEM = `You translate Pokémon Trading Card Game text into a small, fixed instruction set. You are not playing the game or judging it — you are compiling it.

RULES, in order of importance:

1. Only use the operations listed in the schema. Never invent one. If a card does something the vocabulary cannot express, emit {"do":"manual","note":"<the printed wording>"} and lower your confidence. A manual note is a correct answer. An invented opcode is silently ignored by the engine, which is the worst possible outcome.

2. The printed damage number is ALREADY known — do not repeat it. "attacks[i].bonus" is only for damage BEYOND the printed number, such as "and 30 more damage if...". An attack that just deals its printed damage has no bonus and no effects.

3. "modifiers" are CONTINUOUS: true for as long as the card is in play. A Tool that adds 20 damage, an Ability that reduces retreat, a Stadium that changes something. They are not actions and never go in "play".

4. "play" is for Trainers and Supporters: what happens once, when the card is played.

5. "provides" is for Energy cards only — which symbols it pays. Use "*" for "any one type". A basic Fire Energy is ["Fire"]. A Double Colorless is ["Colorless","Colorless"]. Leave it out for anything that is not an Energy card.

6. confidence is 0 to 1 and must be honest. Use 0.95+ only when the card is fully expressed by the operations you emitted. Use below 0.85 whenever anything was approximated, guessed, or left to "manual" — the engine will then execute nothing automatically and let the players decide, which is the safe outcome and not a failure.

Answer with JSON only.`;

export interface EffectStatus {
  /** Cards holding printed text — the ones that CAN be compiled. */
  compilable: number;
  /** …already compiled at the current schema version. */
  compiled: number;
  /** …still to do. */
  pending: number;
  /** Compiled but below the trust line, so still played by hand. */
  lowConfidence: number;
}

async function countRows(
  admin: SupabaseClient,
  build: (q: ReturnType<SupabaseClient["from"]>) => unknown
): Promise<number> {
  const q = build(admin.from("cards")) as { count?: number | null };
  const res = (await q) as unknown as { count: number | null };
  return res.count ?? 0;
}

export async function effectStatus(admin: SupabaseClient): Promise<EffectStatus> {
  const head = { count: "exact" as const, head: true };
  const [compilable, compiled, lowConfidence] = await Promise.all([
    countRows(admin, (t) => t.select("id", head).not("battle_data", "is", null)),
    countRows(admin, (t) => t.select("id", head).eq("effects_v", EFFECT_SCHEMA_VERSION)),
    countRows(admin, (t) =>
      t.select("id", head).eq("effects_v", EFFECT_SCHEMA_VERSION).lt("effects->>confidence", "0.85")
    ).catch(() => 0),
  ]);
  return {
    compilable,
    compiled,
    pending: Math.max(0, compilable - compiled),
    lowConfidence,
  };
}

export interface EffectBatchResult {
  examined: number;
  compiled: number;
  /** Compiled, but below the trust line — worth an admin's eye. */
  unsure: Array<{ id: string; name: string; note: string; confidence: number }>;
  failed: Array<{ id: string; name: string; reason: string }>;
  next: string | null;
  done: boolean;
}

interface Row {
  id: string;
  name: string | null;
  supertype: string | null;
  battle_data: unknown;
  effects_v: number | null;
}

interface PrintedText {
  attacks?: Array<{ name?: string; cost?: string[]; damage?: string; text?: string | null }>;
  abilities?: Array<{ name?: string; text?: string }>;
  rules?: string[];
}

/** The prompt for one card: everything printed on it, and nothing else. */
function describe(row: Row): string | null {
  const bd = (row.battle_data ?? {}) as PrintedText;
  const lines: string[] = [`Card: ${row.name ?? "(unnamed)"}`];
  if (row.supertype) lines.push(`Type: ${row.supertype}`);

  const attacks = bd.attacks ?? [];
  attacks.forEach((a, i) => {
    lines.push(
      `Attack ${i}: ${a.name ?? "?"} — cost ${(a.cost ?? []).join("/") || "none"}, damage ${a.damage || "none"}${a.text ? ` — ${a.text}` : ""}`
    );
  });
  for (const ab of bd.abilities ?? []) {
    lines.push(`Ability: ${ab.name ?? "?"} — ${ab.text ?? ""}`);
  }
  for (const r of bd.rules ?? []) lines.push(`Rules: ${r}`);

  // Nothing to compile: no attacks, no abilities, no rules text. A plain
  // Basic energy still qualifies via its supertype, because "provides" is
  // worth having even with no text at all.
  const hasContent =
    attacks.length > 0 ||
    (bd.abilities?.length ?? 0) > 0 ||
    (bd.rules?.length ?? 0) > 0 ||
    (row.supertype ?? "").toLowerCase().includes("energy");
  return hasContent ? lines.join("\n") : null;
}

/** Compile one card. Returns null when the model declined or failed — the
 *  caller records nothing, so the card is retried on a later run rather
 *  than being marked done with an empty answer. */
async function compileOne(
  row: Row,
  userId: string | null,
  admin: SupabaseClient
): Promise<CompiledCard | null> {
  const prompt = describe(row);
  if (!prompt) return null;
  const client = anthropic();
  const parsed = await askForJson<Omit<CompiledCard, "v">>(
    client,
    {
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    },
    SCHEMA as unknown as Record<string, unknown>,
    {
      onResponse: (response) => {
        if (userId) return logAiUsage(admin, userId, "card_fx", MODEL, response.usage);
      },
    }
  );
  if (!parsed || typeof parsed.confidence !== "number") return null;

  // Clamp rather than trust. A model that returns 1.4 has not understood the
  // question, and a confidence above the trust line is the one field where
  // being wrong causes the engine to act.
  const confidence = Math.max(0, Math.min(1, parsed.confidence));
  return {
    v: EFFECT_SCHEMA_VERSION,
    ...(parsed.attacks?.length ? { attacks: parsed.attacks } : {}),
    ...(parsed.play?.length ? { play: parsed.play } : {}),
    ...(parsed.modifiers?.length ? { modifiers: parsed.modifiers } : {}),
    ...(parsed.provides?.length ? { provides: parsed.provides } : {}),
    confidence,
    ...(parsed.note ? { note: String(parsed.note).slice(0, 300) } : {}),
  };
}

/** One batch. `after` is the id cursor the client carries between calls. */
export async function effectBatch(
  admin: SupabaseClient,
  after: string | null,
  opts?: { userId?: string | null; ownedOnly?: boolean }
): Promise<EffectBatchResult> {
  let query = admin
    .from("cards")
    .select("id, name, supertype, battle_data, effects_v")
    .not("battle_data", "is", null)
    .order("id")
    .limit(SCAN_WINDOW);
  if (after) query = query.gt("id", after);

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) {
    return { examined: 0, compiled: 0, unsure: [], failed: [], next: null, done: true };
  }

  const todo = rows
    .filter((r) => r.effects_v !== EFFECT_SCHEMA_VERSION)
    .slice(0, COMPILE_PER_BATCH);

  const unsure: EffectBatchResult["unsure"] = [];
  const failed: EffectBatchResult["failed"] = [];
  let compiled = 0;

  // Sequential, not parallel. This walks the whole catalogue over many
  // batches and there is no deadline on it; hammering the API to shave
  // seconds off a background job is how a background job earns a rate limit
  // that then blocks the interactive paths people are waiting on.
  for (const row of todo) {
    try {
      const result = await compileOne(row, opts?.userId ?? null, admin);
      if (!result) {
        failed.push({ id: row.id, name: row.name ?? row.id, reason: "nothing to compile" });
        continue;
      }
      const { error: writeErr } = await admin
        .from("cards")
        .update({
          effects: result,
          effects_v: EFFECT_SCHEMA_VERSION,
          effects_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (writeErr) throw writeErr;
      compiled += 1;
      if (result.confidence < 0.85) {
        unsure.push({
          id: row.id,
          name: row.name ?? row.id,
          note: result.note ?? "no reason given",
          confidence: result.confidence,
        });
      }
    } catch (e) {
      failed.push({
        id: row.id,
        name: row.name ?? row.id,
        reason: e instanceof Error ? e.message : "compile failed",
      });
    }
  }

  return {
    examined: rows.length,
    compiled,
    unsure,
    failed,
    next: rows[rows.length - 1].id,
    done: rows.length < SCAN_WINDOW,
  };
}
