// Asking the model for JSON, and surviving a schema the API won't take.
//
// `output_config.format` guarantees the reply matches a JSON Schema, which is
// exactly what you want when the answer goes straight into a database column.
// But it accepts a SUBSET of JSON Schema, and a keyword outside that subset is
// not ignored — the whole request is rejected with a 400 before the model sees
// it. No answer, no partial answer, no cost, no clue.
//
// That is how every card read in this app failed for weeks. The schema said
// `maxItems: 4` on the attacks array — reasonable, valid JSON Schema, and not
// supported here — so the API returned:
//
//   400 output_config.format.schema: For 'array' type, property 'maxItems' is
//       not supported
//
// and the caller's catch turned it into `null`, which every screen rendered as
// "reading it from the picture didn't work". A card that was perfectly legible
// was never sent to a model at all.
//
// Two lessons, both implemented here:
//
//   1. The limits belong in the DESCRIPTION, not in the schema. The model
//      honours "at most four" perfectly well, and the caller slices the array
//      afterwards anyway — which it must, since the schema was never load
//      bearing.
//   2. A rejected schema must not be fatal. If the API refuses the format, ask
//      again without it and parse what comes back. A validated answer is
//      better; an unvalidated answer is enormously better than none.

import type Anthropic from "@anthropic-ai/sdk";

/** Is this the API refusing our schema, rather than anything about the
 *  request's content? Those need opposite responses: one is retryable
 *  without the schema, the other is not retryable at all. */
function isFormatRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /output_config|json_schema/i.test(msg);
}

/** JSON out of a reply that may or may not be fenced. The unvalidated path
 *  can come back as ```json … ```, which JSON.parse rightly refuses. */
function parseLoose<T>(text: string): T | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Last resort: the outermost braces. A model that added a sentence of
    // preamble has still answered the question.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

/** Ask for a JSON object, with the schema enforced if the API will take it.
 *
 *  `onResponse` fires for whichever attempt produced the answer, so usage
 *  logging stays honest. Throws only what the caller should see: a rejected
 *  schema is handled here, everything else propagates.
 */
export async function askForJson<T>(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  schema: Record<string, unknown>,
  opts?: {
    onResponse?: (response: Anthropic.Message) => Promise<void> | void;
    /** Told what went wrong, when something does. */
    report?: (reason: string) => void;
  }
): Promise<T | null> {
  const readBack = (response: Anthropic.Message): T | null => {
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      opts?.report?.(`the model returned no text (stopped: ${response.stop_reason})`);
      return null;
    }
    const parsed = parseLoose<T>(block.text);
    if (!parsed) opts?.report?.("the model's answer wasn't readable as JSON");
    return parsed;
  };

  try {
    const response = await client.messages.create({
      ...params,
      output_config: { format: { type: "json_schema", schema } },
    });
    await opts?.onResponse?.(response);
    return readBack(response);
  } catch (err) {
    if (!isFormatRejection(err)) throw err;

    // The schema is the problem, not the question. Say so loudly — this is a
    // bug in our own schema and it will keep happening until someone fixes
    // it — then get the answer anyway.
    console.error(
      `ai json: the API refused our schema, retrying without it — ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    const system =
      typeof params.system === "string"
        ? `${params.system}\n\nReply with a single JSON object matching the agreed shape, and nothing else.`
        : params.system;
    const response = await client.messages.create({ ...params, system });
    await opts?.onResponse?.(response);
    return readBack(response);
  }
}
