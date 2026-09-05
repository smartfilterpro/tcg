#!/usr/bin/env node
// TrainerDeck bulk-scan bridge: watch a folder, post each new image as one
// card photo. This is how a document scanner feeds a bulk job.
//
// A Fujitsu fi-8170 (or any sheet-fed scanner) can't POST to an API, but
// every one of its delivery roads ends in a folder of image files named in
// scan order — PaperStream's scan-to-folder, or scan-to-FTP pointed at any
// local FTP server's drop directory. This script watches that folder and
// does the POSTing: filename order becomes seq order, one file per card.
//
//   node scripts/bulk-bridge.mjs --dir ~/scans --job <job id> --key <device key>
//
// Options:
//   --base https://trainerdeck.io   API origin (default)
//   --pass 1                        1 (default) or 2
//   --start-seq 1                   continue a stopped run from here
//   --done sent                     processed files move to this subfolder
//                                   (default "sent"; they are never deleted)
//
// Scanner setup that matters:
//   * One image file per card: JPEG (or PNG), NOT multi-page PDF.
//   * SIMPLEX (front only) — duplex would post every card back as a card.
//   * ~300dpi color is plenty; the reader wants the card, not the grain.
//
// Same halt discipline as the phone page: auth failures and a closed job
// stop the run immediately with the seq to resume from; transient errors
// retry with backoff. Ctrl-C is always safe — re-run with --start-seq set
// to the printed next seq.

import { readdir, stat, rename, mkdir, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";

const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
  }
}
const dir = args.dir;
const job = args.job;
const key = args.key;
const base = (args.base ?? "https://trainerdeck.io").replace(/\/+$/, "");
const pass = args.pass === "2" ? 2 : 1;
const doneDirName = args.done ?? "sent";
let nextSeq = Math.max(1, parseInt(args["start-seq"] ?? "1", 10) || 1);

if (!dir || !job || !key) {
  console.error(
    "Usage: node scripts/bulk-bridge.mjs --dir <folder> --job <job id> --key <device key>\n" +
      "       [--base https://trainerdeck.io] [--pass 1|2] [--start-seq N] [--done sent]"
  );
  process.exit(2);
}

const EXTS = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const MAX_ATTEMPTS = 5;
const doneDir = path.join(dir, doneDirName);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The scanner is still writing a file when we first see it — wait until
 *  its size holds still. */
async function settled(file) {
  try {
    const a = await stat(file);
    if (a.size === 0) return false;
    await sleep(400);
    const b = await stat(file);
    return b.size === a.size;
  } catch {
    return false; // vanished (moved by us, or half-written)
  }
}

class HaltError extends Error {}

async function post(file, seq) {
  const type = EXTS.get(path.extname(file).toLowerCase());
  const buf = await readFile(file);
  let lastError = "unknown error";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 1000);
    try {
      const form = new FormData();
      form.append("job", job);
      form.append("pass", String(pass));
      form.append("seq", String(seq));
      form.append("photo", new Blob([buf], { type }), path.basename(file));
      const res = await fetch(`${base}/api/bulk/photo`, {
        method: "POST",
        headers: { "x-bulk-key": key },
        body: form,
      });
      if (res.status === 200) {
        const body = await res.json();
        if (body.ordinal !== seq) {
          throw new HaltError(
            `sent seq=${seq} but the server assigned ordinal=${body.ordinal} — pairing is drifting, check the job`
          );
        }
        return;
      }
      const text = await res.text().catch(() => res.statusText);
      if (res.status === 401 || res.status === 403 || res.status === 409) {
        throw new HaltError(`HALT ${res.status}: ${text}`);
      }
      lastError = `HTTP ${res.status}: ${text}`;
    } catch (e) {
      if (e instanceof HaltError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new HaltError(`seq=${seq} would not upload after ${MAX_ATTEMPTS} attempts (${lastError})`);
}

// One strictly ordered queue: filename order IS card order, so files are
// posted serially — an fi-8170 at ~1 card/s and an upload at ~1s/photo
// keep pace, and order can never invert on a slow response.
const queued = [];
const seen = new Set();

function enqueue(name) {
  if (seen.has(name)) return;
  const ext = path.extname(name).toLowerCase();
  if (!EXTS.has(ext)) return;
  seen.add(name);
  queued.push(name);
  queued.sort();
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queued.length > 0) {
      const name = queued[0];
      const file = path.join(dir, name);
      if (!(await settled(file))) {
        // Still being written — try again on the next tick.
        seen.delete(name);
        queued.shift();
        setTimeout(() => {
          enqueue(name);
          void pump();
        }, 700);
        continue;
      }
      queued.shift();
      const seq = nextSeq;
      await post(file, seq);
      nextSeq += 1;
      await rename(file, path.join(doneDir, name)).catch(() => {});
      console.log(`✓ seq ${seq} ← ${name}`);
    }
  } catch (e) {
    console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
    console.error(`Stopped. Fix the cause and re-run with --start-seq ${nextSeq}`);
    process.exit(1);
  } finally {
    pumping = false;
  }
}

await mkdir(doneDir, { recursive: true });
console.log(
  `Watching ${dir} → ${base} (job ${job}, pass ${pass}, starting at seq ${nextSeq}).\n` +
    `Processed files move to ${doneDir}. Ctrl-C to stop.`
);

// Anything already in the folder goes first, in name order.
for (const name of (await readdir(dir)).sort()) enqueue(name);
void pump();

watch(dir, (_event, name) => {
  if (!name) return;
  enqueue(name);
  void pump();
});
