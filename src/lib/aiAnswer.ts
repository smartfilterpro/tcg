// Getting an answer out of the model, even when it thinks itself out of room.
//
// Every chat surface in the app had the same shape:
//
//     const block = response.content.find((b) => b.type === "text");
//     answer = block ? block.text : "I ran out of room — try again!";
//
// and that fallback was showing up in normal use. The cause is not a bug in
// the question. Claude 5 reasons before it answers, and that reasoning is
// drawn from the SAME max_tokens budget as the visible reply. Ask something
// genuinely hard — "what's wrong with this deck?", against sixty cards that
// each have to be counted and rules-checked — and the model can spend the
// whole allowance thinking and hit the cap before writing a single word.
// The response then contains a thinking block and no text block, and the
// player gets an apology instead of the answer they paid a credit for.
//
// Three things fix it, in order of how often they matter:
//
//   1. More room. max_tokens is a ceiling, not a charge — raising it costs
//      nothing on the calls that never approach it.
//   2. A retry when the first attempt produced nothing, with a lower
//      reasoning effort so the budget goes to the answer instead of the
//      deliberation. This is the case the old code gave up on.
//   3. Reading EVERY text block, not the first. A response can be split
//      across several, and taking content[0] quietly truncated those.
//
// The retry is deliberately one attempt, and deliberately wrapped: an
// unavailable parameter or a second timeout must degrade to the old
// apology, never to a 500.

import type Anthropic from "@anthropic-ai/sdk";

/** Never let a retry balloon past this, however generous the first cap. */
const RETRY_CEILING = 24000;

/** The model's visible answer: every text block, in order.
 *
 *  Returns "" when there is nothing to show — which is meaningfully
 *  different from "the model chose to say nothing", and the caller decides
 *  what to do about it. */
export function answerText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

/** Did the model use its whole budget without producing an answer? */
export function ranOutOfRoom(response: Anthropic.Message): boolean {
  return response.stop_reason === "max_tokens" && answerText(response) === "";
}

const BRIEF_NUDGE = `

BUDGET NOTE: your previous attempt at this exact request used its entire
token budget on internal reasoning and produced no visible answer, so the
player saw nothing at all. Keep the deliberation short this time and write
the reply. A brief, concrete, partial answer is far more useful than a
perfect one that never gets written.`;

/** Append the nudge to whatever shape the system prompt is in. */
function withNudge(system: Anthropic.MessageStreamParams["system"]) {
  if (typeof system === "string") return system + BRIEF_NUDGE;
  if (Array.isArray(system)) {
    return [...system, { type: "text" as const, text: BRIEF_NUDGE }];
  }
  return system;
}

/** Run a message request and, if it thought itself out of room, run it once
 *  more with a bigger budget and less deliberation.
 *
 *  `onResponse` fires for EVERY attempt, including the retry. Usage logging
 *  belongs there: a retried call really did cost twice, and quietly billing
 *  the player for one of the two would be the wrong kind of tidy.
 */
export async function completeWithRoom(
  client: Anthropic,
  params: Anthropic.MessageStreamParams,
  onResponse?: (response: Anthropic.Message) => Promise<void> | void
): Promise<Anthropic.Message> {
  const first = await client.messages.stream(params).finalMessage();
  await onResponse?.(first);
  if (!ranOutOfRoom(first)) return first;

  console.warn("ai: hit max_tokens with no answer, retrying", {
    model: params.model,
    max_tokens: params.max_tokens,
    output_tokens: first.usage?.output_tokens,
  });

  try {
    const second = await client.messages
      .stream({
        ...params,
        max_tokens: Math.min(RETRY_CEILING, (params.max_tokens ?? 4000) * 2),
        // The lever that actually addresses the cause: bound the reasoning
        // so the budget reaches the reply. Spread last so an explicit
        // effort from the caller is still overridden here — the caller's
        // choice is what just failed.
        output_config: { ...(params.output_config ?? {}), effort: "medium" as const },
        system: withNudge(params.system),
      })
      .finalMessage();
    await onResponse?.(second);
    return answerText(second) ? second : first;
  } catch (err) {
    // A retry that fails leaves us exactly where we already were, which is
    // survivable. Throwing from here would turn a wordy answer into a 500.
    console.error("ai: retry after max_tokens failed", err);
    return first;
  }
}
