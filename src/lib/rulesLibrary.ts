// The rules library's brain: turn an official rules document into
// searchable sections, and answer the assistant's lookups from them.
//
// Two document shapes. MTG's Comprehensive Rules is a plain-text file
// Wizards publishes with every set — numbered to the sub-rule (100.1a),
// which makes natural chunks and citable sections. Pokémon has no such
// file, so its rulebook arrives as pasted text and is chunked by heading.
// Either way the answer the model gets carries section numbers/titles so
// replies can cite instead of gesture.

import type { SupabaseClient } from "@supabase/supabase-js";
import { PublicError } from "@/lib/apiError";

export interface RulesChunk {
  section: string;
  title: string;
  body: string;
}

/** Every shape a paste arrives in, folded to one: BOM stripped, exotic
 *  spaces made ordinary, CR line endings made LF. A PDF copy and the
 *  official TXT should parse the same. */
function normalizeRulesText(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/[\u00A0\u2007\u202F\u2009]/g, " ")
    .replace(/\r\n?/g, "\n");
}

/** Is this text the MTG Comprehensive Rules? It announces itself with
 *  hundreds of NNN.N-numbered lines; a rulebook paste has none. Counted
 *  on trimmed lines so a PDF copy's stray indentation doesn't hide it. */
function looksLikeCompRules(text: string): boolean {
  let hits = 0;
  for (const line of text.split("\n")) {
    if (/^\d{3}\.\d+[a-z]?\b/.test(line.trim())) hits++;
    if (hits > 150) return true;
  }
  return false;
}

/** Comp-rules parser: one chunk per rule number (100.1 plus its lettered
 *  sub-rules), plus glossary entries. Major headings ("100. General")
 *  become the running title. */
function parseCompRules(text: string): RulesChunk[] {
  const out: RulesChunk[] = [];
  const lines = text.split(/\r?\n/);
  let heading = "";
  let current: RulesChunk | null = null;
  let inGlossary = false;
  const flush = () => {
    if (current && current.body.trim()) out.push({ ...current, body: current.body.trim().slice(0, 4000) });
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!inGlossary && /^Glossary$/i.test(line)) {
      flush();
      inGlossary = true;
      heading = "Glossary";
      continue;
    }
    if (inGlossary) {
      // Entries are "Term" on its own line, definition lines after, blank
      // line between entries.
      if (!line) {
        flush();
        continue;
      }
      if (/^Credits$/i.test(line)) {
        flush();
        break;
      }
      if (!current) current = { section: "", title: line.slice(0, 120), body: "" };
      else current.body += (current.body ? "\n" : "") + line;
      continue;
    }
    const major = /^(\d{3})\. (.+)$/.exec(line);
    if (major) {
      flush();
      heading = `${major[1]}. ${major[2]}`;
      continue;
    }
    // Sub-rules (100.1a) join their parent's chunk when it's current; a
    // stray one (the parent lost to formatting) starts its own rather
    // than vanishing.
    const sub = /^(\d{3}\.\d+[a-z])\.?\s*(.*)$/.exec(line);
    if (sub) {
      if (current && sub[1].startsWith(current.section) && current.section) {
        current.body += `\n${sub[1]} ${sub[2]}`;
      } else {
        flush();
        current = { section: sub[1], title: heading, body: `${sub[1]} ${sub[2]}` };
      }
      continue;
    }
    const rule = /^(\d{3}\.\d+)\.?\s*(.*)$/.exec(line);
    if (rule) {
      flush();
      current = { section: rule[1], title: heading, body: `${rule[1]}. ${rule[2]}` };
      continue;
    }
    if (current && line) current.body += `\n${line}`;
  }
  flush();
  return out;
}

/** Generic parser for a pasted rulebook. A heading is a SHORT line that
 *  doesn't read as prose — few words, no sentence punctuation, not
 *  starting lowercase. Everything else packs into ~1400-char chunks under
 *  the latest heading. A PDF copy that arrives as hundreds of short
 *  wrapped lines (which defeated the first version of this — every line
 *  read as a "heading" and NOTHING as body) is caught by the fallback:
 *  zero chunks parsed means the text gets windowed instead, because an
 *  unlabeled chunk beats a silent nothing. */
function parseGenericRules(text: string): RulesChunk[] {
  const out: RulesChunk[] = [];
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+\n/g, "\n").trim())
    .filter(Boolean);
  let heading = "";
  let body = "";
  const flush = () => {
    if (body.trim()) out.push({ section: "", title: heading.slice(0, 120), body: body.trim().slice(0, 4000) });
    body = "";
  };
  const isHeading = (p: string) =>
    !p.includes("\n") &&
    p.length < 60 &&
    p.split(/\s+/).length <= 7 &&
    !/[.:;,!?]$/.test(p) &&
    !/^[a-z]/.test(p);
  for (const p of paras) {
    if (isHeading(p)) {
      flush();
      heading = p;
      continue;
    }
    if (body.length + p.length > 1400) flush();
    body += (body ? "\n\n" : "") + p;
  }
  flush();
  if (out.length >= 10) return out;

  // Fallback: fixed windows on whitespace boundaries. Loses headings,
  // keeps every word searchable.
  const flat = text.replace(/\s+/g, " ").trim();
  const windows: RulesChunk[] = [];
  for (let i = 0; i < flat.length; ) {
    let end = Math.min(i + 1400, flat.length);
    const space = flat.lastIndexOf(" ", end);
    if (space > i + 600) end = space;
    windows.push({ section: "", title: "", body: flat.slice(i, end).trim() });
    i = end;
  }
  return windows.length > out.length ? windows : out;
}

export function parseRulesDocument(raw: string): { chunks: RulesChunk[]; shape: string } {
  const text = normalizeRulesText(raw);
  return looksLikeCompRules(text)
    ? { chunks: parseCompRules(text), shape: "comprehensive rules" }
    : { chunks: parseGenericRules(text), shape: "rulebook text" };
}

/** Replace one game's library with a freshly parsed document. */
export async function importRules(
  admin: SupabaseClient,
  game: "pokemon" | "mtg",
  text: string
): Promise<{ sections: number; shape: string }> {
  const { chunks, shape } = parseRulesDocument(text);
  if (chunks.length < 10) {
    throw new PublicError(
      `Only ${chunks.length} sections came out of that document — it doesn't look like a rules text.`
    );
  }
  const { error: delErr } = await admin.from("rules_sections").delete().eq("game", game);
  if (delErr) throw asImportError(delErr);
  // Batches of 100 — big enough to be quick, small enough that a batch
  // stays well under any request-payload cap between here and Postgres.
  for (let i = 0; i < chunks.length; i += 100) {
    const { error } = await admin
      .from("rules_sections")
      .insert(chunks.slice(i, i + 100).map((c) => ({ game, ...c })));
    if (error) throw asImportError(error, i);
  }
  return { sections: chunks.length, shape };
}

/** Import failures a person can act on say so; everything else is logged
 *  by the route and reported as a write failure with its position. */
function asImportError(err: { message: string }, at?: number): Error {
  if (/rules_sections/.test(err.message)) {
    return new PublicError(
      "The rules library needs a database update — run supabase/migrations/079_rules_library.sql."
    );
  }
  console.error("rules import failed:", err.message);
  return new PublicError(
    `The import failed while writing${at != null ? ` around section ${at}` : ""} — the server log has the database's reason.`,
    500
  );
}

/** The assistant's lookup: rule numbers hit directly, words go through
 *  full-text search, and the result is formatted for citation. */
export async function runRulesLookup(
  admin: SupabaseClient,
  args: { query?: string; game?: string }
): Promise<string> {
  const game = args.game === "mtg" ? "mtg" : "pokemon";
  const query = (args.query ?? "").trim();
  if (!query) return "Give the lookup a phrase or a rule number.";
  try {
    type Row = { section: string; title: string; body: string };
    let rows: Row[] = [];

    const num = /^(\d{3}(?:\.\d+[a-z]?)?)/.exec(query);
    if (num) {
      const { data } = await admin
        .from("rules_sections")
        .select("section, title, body")
        .eq("game", game)
        .like("section", `${num[1]}%`)
        .order("section")
        .limit(6);
      rows = (data ?? []) as Row[];
    }
    if (rows.length === 0) {
      const { data, error } = await admin
        .from("rules_sections")
        .select("section, title, body")
        .eq("game", game)
        .textSearch("tsv", query, { type: "websearch" })
        .limit(6);
      if (error && /rules_sections/.test(error.message)) {
        return "The rules library isn't set up yet (migration 079). Answer from general knowledge and say the official text wasn't available to check.";
      }
      rows = (data ?? []) as Row[];
    }
    if (rows.length === 0) {
      // Words too common or too rare for websearch — a loose ilike pass.
      const { data } = await admin
        .from("rules_sections")
        .select("section, title, body")
        .eq("game", game)
        .ilike("body", `%${query.replace(/[%_]/g, " ").slice(0, 60)}%`)
        .limit(4);
      rows = (data ?? []) as Row[];
    }
    if (rows.length === 0) {
      const { count } = await admin
        .from("rules_sections")
        .select("id", { count: "exact", head: true })
        .eq("game", game);
      return (count ?? 0) === 0
        ? `The ${game === "mtg" ? "Magic" : "Pokémon"} rules library is empty — nothing has been imported. Answer from general knowledge and SAY the official text wasn't available to check.`
        : "No rules section matched that query — try different words or a rule number.";
    }
    return rows
      .map((r) => {
        const head = [r.section, r.title].filter(Boolean).join(" — ");
        return `${head ? `[${head}]\n` : ""}${r.body.slice(0, 1500)}`;
      })
      .join("\n\n")
      .slice(0, 7000);
  } catch (err) {
    return `Rules lookup failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown error"}. Answer from general knowledge and say so.`;
  }
}
