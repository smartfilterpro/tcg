"use client";

// The DeckAI chat, present on every signed-in page.
//
// A launcher pinned bottom-right and a panel above it. It deliberately does
// NOT take over the screen on desktop: most questions are asked *about*
// something on the page — this deck, that card — so covering the page would
// mean answering from memory.

import { useCallback, useEffect, useRef, useState } from "react";
import { AI_NAME, APP_NAME } from "@/lib/branding";
import { containsAffiliateLink } from "@/lib/buyLink";
import { FanMark } from "@/components/Logo";
import Markdown from "@/components/Markdown";
import { OutOfCreditsNote } from "@/components/CreditLock";
import { useCredits } from "@/components/useCredits";
import DeckEditCard, { type DeckEditProposal } from "@/components/DeckEditCard";

interface Msg {
  id?: string;
  role: "user" | "assistant";
  content: string;
  refused?: boolean;
  pending?: boolean;
  /** A deck change DeckAI has proposed. Nothing is written until the
   *  player presses Apply — it rides along with the message so it survives
   *  a reload, which matters because the reply arrives through a job and is
   *  often read after one. */
  meta?: { deckEdit?: DeckEditProposal } | null;
}

/** A definite verdict from the server — as opposed to a network blip,
 *  which just means "poll again". */
class ChatFailed extends Error {}

/** Poll a reply job until it lands. Polling (not a held-open stream) is the
 *  whole cure for the sleeping phone: every fetch here is independent, so
 *  the phone can sleep through any number of them and the first poll after
 *  waking collects the answer. */
async function watchJob(
  jobId: string,
  /** The answer so far, each time the poll finds more of it. */
  onPartial?: (soFar: string) => void
): Promise<{ answer: string; refused?: boolean; pendingEdit?: DeckEditProposal | null }> {
  // Generous, and only enforced while the job still says "running" — a
  // phone asleep past the deadline whose job finished still gets the
  // answer from its first poll after waking.
  const deadline = Date.now() + 3 * 60 * 1000;
  // Ask quickly at first, then settle down.
  //
  // The old loop slept a second and a half before its FIRST ask, so even an
  // answer that was already sitting there couldn't arrive sooner than that.
  // Long replies never noticed; short ones — a rules question, a lookup —
  // were being held up by the poller rather than by the model. Backing off
  // to the old interval keeps a slow reply from being asked about forty
  // times while it writes.
  let wait = 250;
  for (;;) {
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(1500, Math.round(wait * 1.6));
    try {
      const res = await fetch(`/api/assistant?job=${encodeURIComponent(jobId)}`);
      const json = await res.json();
      const job = json?.job;
      if (job?.status === "done" && typeof job.result?.answer === "string") {
        return job.result as {
          answer: string;
          refused?: boolean;
          pendingEdit?: DeckEditProposal | null;
        };
      }
      // Still writing, but there is something to read. The server rewrites
      // this row as the reply is generated, so the person watches it arrive
      // instead of watching a spinner.
      if (job?.status === "running" && typeof job.result?.partial === "string") {
        onPartial?.(job.result.partial);
      }
      if (job?.status === "error" || (job?.status === "done" && !job.result?.answer)) {
        throw new ChatFailed(job.error || "The chat failed");
      }
      if (!job && json?.migrated !== false) throw new ChatFailed("The chat failed");
    } catch (e) {
      if (e instanceof ChatFailed) throw e;
      // Network blip or sleeping phone — the reply is still being written
      // server-side, so keep asking.
    }
    if (Date.now() > deadline) {
      throw new ChatFailed("That reply is taking too long — reopen the chat in a minute.");
    }
  }
}

const STARTERS = [
  "What should I add to my best deck?",
  "What's the most valuable card I own?",
  "How does a Rare Candy work?",
  "Is anything I own worth grading?",
];

/** Hand DeckAI a question from anywhere in the app.
 *
 *  The card sheet's quick-ask chips use this: the chat panel opens and the
 *  question — with the card's identity baked into the text, so the model
 *  looks up the right printing — sends as if typed. An event rather than
 *  context/props because the chat lives in the layout and the askers live
 *  many trees away; one dispatch beats threading a callback through all of
 *  them. */
export function askDeckAI(question: string): void {
  window.dispatchEvent(new CustomEvent("deckai:ask", { detail: { question } }));
}

export default function TrainerChat() {
  const credits = useCredits();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  /** The reply being written right now, shown in place of "Thinking…". */
  const [streaming, setStreaming] = useState("");
  /** The job writing that reply — what the Stop button aims at. */
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [migrated, setMigrated] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The composer grows with what's typed. A fixed one-line box scrolled
  // internally, so anything past a dozen words meant editing through a
  // letterbox. Height follows content up to the existing max-h cap (7rem),
  // then scrolls; keyed off draft so programmatic fills (a quick-ask chip
  // parked while busy, a failed send restoring the question) resize too.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  }, [draft, open]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant");
      const json = await res.json();
      if (res.ok) {
        setMigrated(json.migrated !== false);
        setMsgs(json.messages ?? []);
        // A reply is still being written server-side — the phone slept or
        // the page reloaded mid-answer. The question is already in the
        // history above (it's saved before the model runs); pick the
        // answer up where it was left.
        if (json.job?.id) {
          setBusy(true);
          setActiveJob(json.job.id as string);
          watchJob(json.job.id as string, setStreaming)
            .then((r) => {
              setMsgs((m) => [
                ...m,
                {
                  role: "assistant",
                  content: r.answer,
                  refused: r.refused,
                  meta: r.pendingEdit ? { deckEdit: r.pendingEdit } : null,
                },
              ]);
              credits.refresh();
            })
            .catch((e) => setError(e instanceof Error ? e.message : "The chat failed"))
            .finally(() => {
              setStreaming("");
              setBusy(false);
              setActiveJob(null);
            });
        }
      }
    } catch {}
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // History is fetched when the panel is first opened, not on every page
  // load — this component mounts on every screen in the app.
  useEffect(() => {
    if (open && !loaded) load();
  }, [open, loaded, load]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, open, busy, streaming]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Questions handed over from elsewhere in the app (see askDeckAI). If a
  // reply is already being written, the question waits in the box rather
  // than interleaving two answers.
  useEffect(() => {
    const onAsk = (e: Event) => {
      const q = (e as CustomEvent<{ question?: string }>).detail?.question?.trim();
      if (!q) return;
      setOpen(true);
      if (busy) setDraft(q);
      else void send(q);
    };
    window.addEventListener("deckai:ask", onAsk);
    return () => window.removeEventListener("deckai:ask", onAsk);
    // send closes over current state; re-binding per render keeps it fresh.
  });

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setDraft("");
    setError(null);
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: question }]);
    // Whether the question made it into a server-side job. Before that
    // point a failure means the question went nowhere, so it goes back in
    // the box; after it, the question is in the saved history and the
    // reply may still arrive — removing the bubble would misreport.
    let accepted = false;
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "The chat failed");
      let reply: { answer: string; refused?: boolean; pendingEdit?: DeckEditProposal | null };
      if (typeof json.answer === "string") {
        // The no-cost fast path (off-topic refusals) still answers inline.
        reply = json;
      } else if (json.jobId) {
        // The reply is a job now: the model runs server-side and the
        // answer lands in history whatever happens to this tab, so a
        // phone that locks mid-answer costs nothing but the wait.
        accepted = true;
        setActiveJob(json.jobId as string);
        reply = await watchJob(json.jobId as string, setStreaming);
      } else {
        throw new Error("The chat failed");
      }
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          content: reply.answer,
          refused: reply.refused,
          meta: reply.pendingEdit ? { deckEdit: reply.pendingEdit } : null,
        },
      ]);
      // Re-read the balance: this is the one surface someone uses repeatedly
      // in a sitting, so it's where the lock has to appear on time rather
      // than at the next page load.
      credits.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The chat failed");
      if (!accepted) setMsgs((m) => m.slice(0, -1));
      // Put the question back so a retry is one tap.
      setDraft(question);
    }
    setStreaming("");
    setBusy(false);
    setActiveJob(null);
  }

  /** Stop the reply being written. The job still finishes — as "done", with
   *  whatever text had already streamed — so the normal poll collects it and
   *  no state here needs unwinding. */
  async function stopReply() {
    if (!activeJob) return;
    try {
      await fetch("/api/assistant", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: activeJob }),
      });
    } catch {
      // The poll's deadline still bounds the wait if the stop didn't land.
    }
  }

  async function clearHistory() {
    if (
      !confirm(
        `Start a new conversation? The current one is cleared and ${AI_NAME} won't remember what you've discussed.`
      )
    ) {
      return;
    }
    await fetch("/api/assistant", { method: "DELETE" });
    setMsgs([]);
  }

  return (
    <>
      {/* launcher */}
      <button
        aria-label={open ? `Close ${AI_NAME}` : `Ask ${AI_NAME}`}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setTimeout(() => inputRef.current?.focus(), 80);
        }}
        // z-[55]: above the card sheets (z-50), below the full-screen card
        // zoom (z-60) — the quick-ask chips live INSIDE those sheets, and a
        // chat that opened underneath one answered into the void.
        className={`fixed bottom-4 right-4 z-[55] flex h-[52px] items-center gap-2.5 rounded-full px-4 text-brand-canvas shadow-lg transition-transform hover:scale-105 sm:bottom-6 sm:right-6 ${
          open ? "bg-brand-ink2" : "bg-brand-ink"
        }`}
      >
        {open ? (
          <span className="px-1 text-lg leading-none">✕</span>
        ) : (
          <>
            <FanMark size={22} reversed />
            <span className="hidden text-[13.5px] font-medium sm:inline">Ask {AI_NAME}</span>
          </>
        )}
      </button>

      {/* Wider on a big screen than the 30rem it used to be fixed at. A
          deckbuilding answer is a page of structure, and a phone-width column
          on a 27" monitor makes it four screens of scrolling. */}
      {open && (
        <div
          className="fixed inset-x-0 bottom-0 z-[55] flex max-h-[86vh] flex-col rounded-t-[20px] border border-brand-line bg-brand-canvas shadow-2xl sm:inset-x-auto sm:bottom-24 sm:right-6 sm:max-h-[min(720px,80vh)] sm:w-[min(32rem,calc(100vw-3rem))] sm:rounded-[20px] lg:max-h-[min(820px,82vh)] lg:w-[38rem]"
          role="dialog"
          aria-label={`${AI_NAME} chat`}
        >
          <div className="flex items-center gap-2.5 border-b border-brand-line px-4 py-3">
            <FanMark size={20} />
            <div className="min-w-0 flex-1">
              <div className="font-display text-[15px] font-bold leading-tight">{AI_NAME}</div>
              <div className="text-[11.5px] text-brand-ink4">
                Knows your cards and decks
              </div>
            </div>
            {msgs.length > 0 && (
              <button
                className="shrink-0 text-right text-[11.5px] leading-tight text-brand-ink5 hover:text-brand-ink hover:underline"
                onClick={clearHistory}
              >
                Start new conversation
              </button>
            )}
            <button
              aria-label="Close"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-brand-ink4 hover:bg-brand-sunken sm:hidden"
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {!migrated && (
              <div className="rounded-[14px] border border-[#F0DFA8] bg-[#FFF8E1] px-3.5 py-3 text-[12.5px] leading-[1.55] text-[#7A5A12]">
                The chat needs a one-time database update — ask the admin to run{" "}
                <code className="font-mono">supabase/migrations/029_assistant_chat.sql</code>.
              </div>
            )}

            {migrated && msgs.length === 0 && (
              <div className="py-2">
                <p className="mb-3 text-[13.5px] leading-[1.6] text-brand-ink3">
                  Ask me anything about Pokémon — the cards, the rules, your decks, what&apos;s
                  worth grading. I can see your collection, so &ldquo;what should I put in
                  this deck&rdquo; is a fair question.
                </p>
                <div className="flex flex-col gap-1.5">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      className="rounded-[12px] border border-brand-line bg-white px-3 py-2 text-left text-[13px] hover:border-brand-line-strong"
                      onClick={() => send(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2.5">
              {msgs.map((m, i) =>
                m.role === "user" ? (
                  <div
                    key={m.id ?? i}
                    className="ml-auto max-w-[88%] whitespace-pre-wrap rounded-[14px] bg-brand-ink px-3.5 py-2.5 text-[13.5px] leading-[1.55] text-brand-canvas"
                  >
                    {m.content}
                  </div>
                ) : (
                  // Answers get the full width of the panel. They're
                  // structured — headings, buy-lists, sometimes a table — and
                  // an 88% column threw away a tenth of an already narrow
                  // measure for the sake of a chat-bubble silhouette.
                  <div
                    key={m.id ?? i}
                    className={`rounded-[14px] px-3.5 py-3 text-[13.5px] leading-[1.6] ${
                      m.refused
                        ? "max-w-[88%] bg-brand-sunken text-brand-ink3"
                        : "bg-white text-brand-ink2 ring-1 ring-brand-line"
                    }`}
                  >
                    <Markdown text={m.content} />
                    {m.meta?.deckEdit && <DeckEditCard proposal={m.meta.deckEdit} />}
                  </div>
                )
              )}
              {busy &&
                (streaming ? (
                  // The reply as it is being written. Same bubble as a
                  // finished answer, so it doesn't jump when it lands.
                  <div className="rounded-[14px] bg-white px-3.5 py-2.5 text-[13px] leading-[1.6] ring-1 ring-brand-line">
                    <Markdown text={streaming} />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-[14px] bg-white px-3.5 py-2.5 ring-1 ring-brand-line">
                    <FanMark size={15} className="animate-spin-slow shrink-0" />
                    <span className="animate-pulse text-[13px] text-brand-ink4">Thinking…</span>
                  </div>
                ))}
              <div ref={endRef} />
            </div>

            {/* The same disclosure the meta and sets pages carry, because the
                same wrapped links now render here. Keyed off the links
                actually present, not a setting — a plain tcgplayer.com link
                (no affiliate program configured) needs no disclosure. */}
            {msgs.some((m) => m.role === "assistant" && containsAffiliateLink(m.content)) && (
              <p className="mt-2 text-center text-[11px] text-brand-ink5">
                {APP_NAME} earns a small commission on TCGplayer purchases made through buy
                links — at no extra cost to you.
              </p>
            )}

            {error && <p className="mt-2 text-[12.5px] text-brand-negative">{error}</p>}
          </div>

          {/* Out of credits: the composer is replaced rather than left to
              fail on send. Shown to paid plans on the same terms — a Pro who
              has spent the month's allowance is in exactly this position,
              and hiding that until they press send would be worse. */}
          {credits.empty ? (
            <div className="border-t border-brand-line px-4 py-3">
              <OutOfCreditsNote plan={credits.credits?.plan} />
            </div>
          ) : (
          <form
            className="flex items-end gap-2 border-t border-brand-line px-3 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            <textarea
              ref={inputRef}
              rows={1}
              maxLength={2000}
              className="max-h-28 min-h-[38px] flex-1 resize-none overflow-y-auto rounded-[14px] border border-brand-line-strong bg-white px-3 py-2 text-[13.5px] outline-none focus:border-brand-accent"
              placeholder={`Ask about Pokémon…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line — the convention
                // for a chat box rather than a form field.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
            />
            {busy && activeJob ? (
              // The send arrow becomes a stop square while a reply writes —
              // the same spot a person's thumb is already over, and the one
              // thing they can usefully do right now.
              <button
                type="button"
                aria-label="Stop the reply"
                className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-brand-ink text-brand-canvas"
                onClick={stopReply}
              >
                <span className="block h-3 w-3 rounded-[2px] bg-brand-canvas" />
              </button>
            ) : (
              <button
                aria-label="Send"
                className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-brand-ink text-brand-canvas disabled:opacity-40"
                disabled={busy || !draft.trim()}
              >
                ↑
              </button>
            )}
          </form>
          )}
        </div>
      )}
    </>
  );
}
