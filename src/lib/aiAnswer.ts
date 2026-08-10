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

/** Came back with nothing to show the player, for ANY reason.
 *
 *  Running out of room is the common cause and the one this module was built
 *  for, but it is not the only one — a turn can end with a thinking block
 *  and no text on an ordinary `end_turn` too, and that case was falling
 *  straight past the retry into the apology. From where the player sits the
 *  two are identical: they asked a question and got a shrug.
 *
 *  A tool call is NOT a missing answer. The model is mid-task and the caller
 *  is expected to run the tool and come back, so retrying here would throw
 *  away a perfectly good turn. */
export function producedNoAnswer(response: Anthropic.Message): boolean {
  if (answerText(response) !== "") return false;
  return !response.content.some((b) => b.type === "tool_use");
}

/** What happened, in one line, for the server log. A bare "no answer" says
 *  nothing about which of several very different failures occurred. */
export function answerDiagnosis(response: Anthropic.Message): string {
  const kinds = response.content.map((b) => b.type);
  return (
    `stop_reason=${response.stop_reason ?? "?"} ` +
    `blocks=[${kinds.join(", ") || "none"}] ` +
    `out=${response.usage?.output_tokens ?? "?"} in=${response.usage?.input_tokens ?? "?"}`
  );
}

/** What to show when there is genuinely nothing to show — and a log line
 *  saying why.
 *
 *  Every chat surface had its own wording for this, and all of them asserted
 *  the same cause: "I thought about that one too long and ran out of room."
 *  That is one specific failure, and it was being used for all of them. When
 *  a turn comes back empty on an ordinary end_turn, telling the player it
 *  was too much thinking is a guess dressed as an explanation — and it sends
 *  them off rewording a question that was never the problem.
 *
 *  @param where names the surface, so a log line can be traced to a screen.
 */
export function noAnswerReply(response: Anthropic.Message, where: string): string {
  console.error(`ai: empty answer shown to a player in ${where} — ${answerDiagnosis(response)}`);
  if (response.stop_reason === "max_tokens") {
    return "I spent my whole budget working that out and never got to the answer — ask me again, and narrower if you can?";
  }
  return "That came back empty on my side — nothing to do with your question. Ask me again?";
}

const BRIEF_NUDGE = `

BUDGET NOTE: your previous attempt at this exact request used its entire
token budget on internal reasoning and produced no visible answer, so the
player saw nothing at all. Keep the deliberation short this time and write
the reply. A brief, concrete, partial answer is far more useful than a
perfect one that never gets written.`;

/** What to say on the round where the tools are closed.
 *
 *  The loops forbid tool use on their last round so the turn can't end on a
 *  call nothing will run. Forbidding is not the same as redirecting: a model
 *  whose plan was "propose the deck edit" and whose only move has just been
 *  taken away can spend the round thinking about a dead end and stop without
 *  writing anything — an empty turn, on an ordinary end_turn, which is
 *  exactly what a player was shown twice in a row. Telling it what to do
 *  INSTEAD costs one short message and gives the plan somewhere to go. */
export const FINAL_ROUND_NOTE =
  "This is the last step of this turn — no more lookups or tools are available, " +
  "and anything you don't say now the player never sees. Write your answer in " +
  "plain text using what you already have. If you were about to propose a deck " +
  "change, describe it in words instead: name the cards in and out and why.";

/** Add the final-round note to a message list, in place.
 *
 *  Merged into the trailing user turn rather than appended as a new one. The
 *  last message before this round is a user turn carrying tool results, and
 *  two user messages in a row is a shape worth not betting a working chat
 *  on — a 400 here would break every conversation to fix an empty one. */
export function addFinalRoundNote(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  const note = { type: "text" as const, text: FINAL_ROUND_NOTE };
  if (!last || last.role !== "user") {
    messages.push({ role: "user", content: [note] });
    return;
  }
  const content = Array.isArray(last.content)
    ? [...last.content, note]
    : [{ type: "text" as const, text: String(last.content) }, note];
  messages[messages.length - 1] = { role: "user", content };
}

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
  onResponse?: (response: Anthropic.Message) => Promise<void> | void,
  /** Called with the answer so far, as it is written.
   *
   *  The reply already arrives from the API a token at a time; until now
   *  that was collected in silence and shown all at once, so the person
   *  waited out the whole generation staring at "Thinking…". Handing the
   *  partial text to the caller lets it be put somewhere the browser can
   *  see it.
   *
   *  Resets to the empty string at the start of each attempt, so a retry
   *  replaces the abandoned text rather than appending to it. */
  onText?: (soFar: string) => void
): Promise<Anthropic.Message> {
  /** Wraps a stream so its text is reported as it arrives. */
  const streamed = (p: Anthropic.MessageStreamParams) => {
    const stream = client.messages.stream(p);
    if (onText) {
      let soFar = "";
      onText("");
      stream.on("text", (delta) => {
        soFar += delta;
        onText(soFar);
      });
    }
    return stream.finalMessage();
  };

  const first = await streamed(params);
  await onResponse?.(first);
  if (!producedNoAnswer(first)) return first;

  console.warn(
    `ai: no answer from ${params.model}, retrying — ${answerDiagnosis(first)} ` +
      `max_tokens=${params.max_tokens}`
  );

  try {
    const second = await streamed({
        ...params,
        max_tokens: Math.min(RETRY_CEILING, (params.max_tokens ?? 4000) * 2),
        // The lever that actually addresses the cause: bound the reasoning
        // so the budget reaches the reply. Spread last so an explicit
        // effort from the caller is still overridden here — the caller's
        // choice is what just failed.
        output_config: { ...(params.output_config ?? {}), effort: "medium" as const },
        system: withNudge(params.system),
      });
    await onResponse?.(second);
    if (answerText(second)) return second;

    // Third and last: no thinking at all.
    //
    // Two silent turns means the deliberation is not merely long, it is
    // where the whole turn is going — the model reasons, decides, and never
    // writes. Bounding the effort didn't stop it, so this removes the option
    // entirely: with thinking disabled the only thing the model can emit is
    // the answer. It is a worse answer than the one that never arrived, and
    // an enormously better one than an apology.
    //
    // Tools are dropped for the same reason — a tool call here would be
    // another turn with nothing in it for the player.
    console.error(
      `ai: no answer from ${params.model} twice — first: ${answerDiagnosis(first)} · ` +
        `second: ${answerDiagnosis(second)}. Trying once more with thinking off.`
    );
    const { output_config: _dropped, tools: _noTools, tool_choice: _noChoice, ...rest } = params;
    const third = await streamed({
      ...rest,
      thinking: { type: "disabled" as const },
      system: withNudge(params.system),
    });
    await onResponse?.(third);
    if (answerText(third)) return third;
    console.error(`ai: STILL no answer with thinking off — ${answerDiagnosis(third)}`);
    return first;
  } catch (err) {
    // A retry that fails leaves us exactly where we already were, which is
    // survivable. Throwing from here would turn a wordy answer into a 500.
    console.error("ai: retry after max_tokens failed", err);
    return first;
  }
}
