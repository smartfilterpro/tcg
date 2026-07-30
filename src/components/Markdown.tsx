// Renders the markdown the AI actually writes.
//
// Every AI surface in the app used to print its answer through
// `whitespace-pre-wrap`, which shows "**Ultra Ball**" with the asterisks and
// runs a bulleted buy-list together as one grey slab. The model has been
// writing structure all along; nothing was reading it.
//
// This is deliberately not a general CommonMark implementation. It covers the
// constructs a chat answer actually uses — headings, bold, italic, inline
// code, fenced code, bullet and numbered lists (nested), block quotes, pipe
// tables, rules — and ignores the rest, which then falls through as plain
// text. That is the right failure: an unhandled construct reads a little
// worse, it never breaks the page.
//
// SECURITY: this builds React elements, never an HTML string, and there is no
// dangerouslySetInnerHTML anywhere in it. That matters because the model's
// answer quotes the player's own data — card names, deck names, trade posts —
// and some of that is other people's text. React escapes every string node it
// renders, so the worst a hostile deck name can do is look odd.
//
// Links are rendered as their label only, never as an anchor, for the same
// reason: a URL that arrives inside model output is not something the app
// should be handing the reader a click on.

import { Fragment, type ReactNode } from "react";

/* ------------------------------------------------------------------ inline */

// Built fresh per call rather than hoisted: the matcher is stateful (`g` keeps
// `lastIndex`), and this function recurses into its own matches for nesting,
// so a shared instance would have inner calls trampling the outer cursor.
function inlineMatcher(): RegExp {
  return new RegExp(
    [
      // The `(?<![A-Za-z0-9])` guard is CommonMark's flanking rule, cut down
      // to the case that actually bites: a marker sitting against a word or
      // digit isn't emphasis. Without it "prices are $1*, and 4*4 is 16"
      // italicises everything between the two asterisks.
      "(?<![A-Za-z0-9])(\\*\\*|__)(?=\\S)([\\s\\S]*?\\S)\\1", // **bold**
      "(?<![A-Za-z0-9])\\*(?=\\S)([^*\\n]*?\\S)\\*(?![A-Za-z0-9])", // *italic*
      //   asterisk only; `_` alone is left as text because it turns up
      //   mid-token in set codes and card ids.
      "`([^`\\n]+)`", // `code`
      "\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)", // [label](url) → label
    ].join("|"),
    "g"
  );
}

/** Inline spans of one line of markdown. */
export function inlineNodes(src: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = inlineMatcher();
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[2] != null) {
      out.push(
        <strong key={k} className="font-semibold text-brand-ink">
          {inlineNodes(m[2], k)}
        </strong>
      );
    } else if (m[3] != null) {
      out.push(
        <em key={k} className="italic">
          {inlineNodes(m[3], k)}
        </em>
      );
    } else if (m[4] != null) {
      out.push(
        <code key={k} className="rounded bg-brand-sunken px-1 py-px font-mono text-[.92em]">
          {m[4]}
        </code>
      );
    } else if (m[5] != null) {
      out.push(<Fragment key={k}>{m[5]}</Fragment>);
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

/* ------------------------------------------------------------------ blocks */

const ITEM = /^(\s*)([-*•]|\d{1,3}[.)])\s+(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const FENCE = /^\s*(?:```|~~~)/;
const QUOTE = /^ {0,3}> ?/;
// A paragraph that is nothing but one bold run. The model writes its section
// headers this way far more often than it writes `##`, and rendering them as
// body text is most of why long answers read as a wall.
const BOLD_ONLY = /^\*\*([^*][\s\S]*?)\*\*$/;

const H_CLASS: Record<number, string> = {
  1: "font-display text-[1.12em] font-bold leading-snug text-brand-ink",
  2: "font-display text-[1.06em] font-bold leading-snug text-brand-ink",
  3: "font-display text-[1em] font-bold leading-snug text-brand-ink",
};

function headingClass(level: number): string {
  return H_CLASS[level] ?? H_CLASS[3];
}

/** A table, if `lines[i]` starts one: a header row, then a `|---|` divider. */
function tableAt(lines: string[], i: number): { node: ReactNode; next: number } | null {
  const header = lines[i];
  const divider = lines[i + 1];
  if (!header?.includes("|") || !divider) return null;
  if (!/^[\s|:-]*$/.test(divider) || !divider.includes("-") || !divider.includes("|")) return null;

  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());

  const head = cells(header);
  const body: string[][] = [];
  let j = i + 2;
  while (j < lines.length && lines[j].includes("|") && lines[j].trim()) {
    body.push(cells(lines[j]));
    j++;
  }

  const node = (
    // Wide tables scroll inside the bubble instead of pushing the panel out.
    <div key={`t${i}`} className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[18rem] border-collapse text-[.94em]">
        <thead>
          <tr>
            {head.map((c, x) => (
              <th
                key={x}
                className="border-b border-brand-line px-2 py-1 text-left font-semibold text-brand-ink"
              >
                {inlineNodes(c, `th${i}-${x}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, y) => (
            <tr key={y}>
              {head.map((_, x) => (
                <td
                  key={x}
                  className="border-b border-brand-line-soft px-2 py-1 align-top text-brand-ink2"
                >
                  {inlineNodes(row[x] ?? "", `td${i}-${y}-${x}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return { node, next: j };
}

/** One run of list items starting at `lines[i]`, including anything indented
 *  underneath them — which is how nesting arrives. */
function listAt(lines: string[], i: number, key: string): { node: ReactNode; next: number } {
  const first = ITEM.exec(lines[i])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? Number(first[2].replace(/\D/g, "")) : 1;
  const items: string[][] = [];

  while (i < lines.length) {
    const line = lines[i];
    const m = ITEM.exec(line);

    if (m && m[1].length <= indent + 1) {
      // A sibling — unless it switched between bulleted and numbered, which
      // is a new list rather than a continuation of this one.
      if (/\d/.test(m[2]) !== ordered) break;
      items.push([m[3]]);
      i++;
      continue;
    }
    if (!line.trim()) {
      // A blank line inside a list is normal ("loose" list). It only ends the
      // list if what follows is neither another item nor indented under one.
      const next = lines[i + 1];
      if (next && (ITEM.test(next) || /^\s{2,}\S/.test(next))) {
        i++;
        continue;
      }
      break;
    }
    if (items.length && /^\s+\S/.test(line)) {
      // Indented under the current item: a nested list or a second paragraph.
      // Strip one level of indent and let the recursive pass sort it out.
      items[items.length - 1].push(line.replace(new RegExp(`^\\s{0,${indent + 2}}`), ""));
      i++;
      continue;
    }
    break;
  }

  const rendered = items.map((lns, x) => (
    <li key={x} className="pl-0.5">
      {lns.length === 1 ? (
        inlineNodes(lns[0], `${key}-${x}`)
      ) : (
        <div className="space-y-1.5">{renderBlocks(lns, `${key}-${x}`)}</div>
      )}
    </li>
  ));

  const node = ordered ? (
    <ol
      key={key}
      start={start}
      className="my-0 list-decimal space-y-1 pl-[1.35em] marker:font-mono marker:text-[.9em] marker:text-brand-ink4"
    >
      {rendered}
    </ol>
  ) : (
    <ul key={key} className="my-0 list-disc space-y-1 pl-[1.2em] marker:text-brand-ink4">
      {rendered}
    </ul>
  );
  return { node, next: i };
}

function renderBlocks(lines: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence, or the end of the text if the model never closed it
      out.push(
        <pre
          key={`${key}f${i}`}
          className="overflow-x-auto rounded-[10px] bg-brand-sunken p-2.5 font-mono text-[.88em] leading-[1.5] text-brand-ink2"
        >
          {buf.join("\n")}
        </pre>
      );
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(
        <p key={`${key}h${i}`} className={`m-0 ${headingClass(level)}`}>
          {inlineNodes(h[2], `${key}h${i}`)}
        </p>
      );
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr key={`${key}r${i}`} className="my-1 border-brand-line" />);
      i++;
      continue;
    }

    const table = tableAt(lines, i);
    if (table) {
      out.push(table.node);
      i = table.next;
      continue;
    }

    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (buf.length && lines[i].trim()))) {
        buf.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      out.push(
        <blockquote
          key={`${key}q${i}`}
          className="border-l-2 border-brand-line-strong pl-3 text-brand-ink3"
        >
          <div className="space-y-1.5">{renderBlocks(buf, `${key}q${i}`)}</div>
        </blockquote>
      );
      continue;
    }

    if (ITEM.test(line)) {
      const list = listAt(lines, i, `${key}l${i}`);
      out.push(list.node);
      i = list.next;
      continue;
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      if (buf.length && (ITEM.test(l) || HEADING.test(l) || FENCE.test(l) || QUOTE.test(l))) break;
      buf.push(l);
      i++;
    }
    const text = buf.join("\n").trim();
    const bold = BOLD_ONLY.exec(text);
    if (bold) {
      out.push(
        <p key={`${key}p${i}`} className={`m-0 ${headingClass(3)}`}>
          {inlineNodes(bold[1], `${key}p${i}`)}
        </p>
      );
      continue;
    }
    out.push(
      <p key={`${key}p${i}`} className="m-0">
        {/* A hard line break inside a paragraph is deliberate when a model
            writes one — it doesn't wrap prose the way a human typing does. */}
        {buf.map((l, x) => (
          <Fragment key={x}>
            {x > 0 && <br />}
            {inlineNodes(l, `${key}p${i}-${x}`)}
          </Fragment>
        ))}
      </p>
    );
  }

  return out;
}

/** Markdown from the assistant, as elements. Font size and colour are
 *  inherited so each surface keeps its own scale. */
export default function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return <div className={`space-y-2 ${className}`.trim()}>{renderBlocks(lines, "b")}</div>;
}
