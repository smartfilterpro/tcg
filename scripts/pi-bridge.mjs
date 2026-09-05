#!/usr/bin/env node
// TrainerDeck Pi bridge: the scanning bench's appliance.
//
// Lives on a Raspberry Pi next to the document scanner. The scanner
// delivers images into a folder on the Pi (PaperStream scan-to-folder to
// a network share, or scan-to-FTP into a local FTP server's drop dir —
// `sudo apt install vsftpd`, point its landing directory at --dir). This
// app watches the folder and posts each file to the TrainerDeck bulk
// intake in filename order, and serves a WEB PAGE for the whole
// workflow: enter the rig key once, then per customer stack — type a
// label, tap "New job", feed the scanner, watch the counter climb.
//
//   node scripts/pi-bridge.mjs --dir /home/pi/scans [--port 8321]
//
// Config (server URL, rig key, current job) persists in
// pi-bridge-config.json next to the working directory, so a reboot picks
// up where it left off. Run it as a service:
//
//   # /etc/systemd/system/tcg-bridge.service
//   [Unit]
//   Description=TrainerDeck scan bridge
//   After=network-online.target
//   [Service]
//   ExecStart=/usr/bin/node /home/pi/pi-bridge.mjs --dir /home/pi/scans
//   WorkingDirectory=/home/pi
//   Restart=always
//   User=pi
//   [Install]
//   WantedBy=multi-user.target
//
// The page has no login — anyone on your LAN can reach it. That is the
// intended trust model for a bench appliance; don't port-forward it.

import { readdir, stat, rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
  }
}
const dir = args.dir;
const port = Math.max(1, parseInt(args.port ?? "8321", 10) || 8321);
if (!dir) {
  console.error("Usage: node scripts/pi-bridge.mjs --dir <scan folder> [--port 8321]");
  process.exit(2);
}
const CONFIG_FILE = path.resolve("pi-bridge-config.json");
const doneDir = path.join(dir, "sent");

// ---------------------------------------------------------------- state
const cfg = {
  base: "https://trainerdeck.io",
  rigKey: "",
  job: null, // { id, key, label }
  nextSeq: 1,
  pass: 1,
};
try {
  Object.assign(cfg, JSON.parse(await readFile(CONFIG_FILE, "utf8")));
} catch {
  // first run
}
async function saveCfg() {
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let running = false;
let lastError = null;
let sentThisSession = 0;
const log = [];
function say(line) {
  log.push(`${new Date().toLocaleTimeString()} ${line}`);
  if (log.length > 60) log.shift();
  console.log(line);
}

// ---------------------------------------------------------------- pump
const EXTS = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class HaltError extends Error {}

async function settled(file) {
  try {
    const a = await stat(file);
    if (a.size === 0) return false;
    await sleep(400);
    const b = await stat(file);
    return b.size === a.size;
  } catch {
    return false;
  }
}

async function post(file, seq) {
  const type = EXTS.get(path.extname(file).toLowerCase());
  const buf = await readFile(file);
  let lastErr = "unknown error";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 1000);
    try {
      const form = new FormData();
      form.append("job", cfg.job.id);
      form.append("pass", String(cfg.pass));
      form.append("seq", String(seq));
      form.append("photo", new Blob([buf], { type }), path.basename(file));
      const res = await fetch(`${cfg.base}/api/bulk/photo`, {
        method: "POST",
        headers: { "x-bulk-key": cfg.job.key },
        body: form,
      });
      if (res.status === 200) {
        const body = await res.json();
        if (body.ordinal !== seq) {
          throw new HaltError(`server assigned ordinal ${body.ordinal} for seq ${seq} — check the job`);
        }
        return;
      }
      const text = await res.text().catch(() => res.statusText);
      if ([401, 403, 409].includes(res.status)) throw new HaltError(`HALT ${res.status}: ${text}`);
      lastErr = `HTTP ${res.status}: ${text}`;
    } catch (e) {
      if (e instanceof HaltError) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new HaltError(`seq=${seq} would not upload after 5 attempts (${lastErr})`);
}

const queued = [];
const seen = new Set();
function enqueue(name) {
  if (seen.has(name) || !EXTS.has(path.extname(name).toLowerCase())) return;
  seen.add(name);
  queued.push(name);
  queued.sort();
}

let pumping = false;
async function pump() {
  if (pumping || !running || !cfg.job) return;
  pumping = true;
  try {
    while (running && queued.length > 0) {
      const name = queued[0];
      const file = path.join(dir, name);
      if (!(await settled(file))) {
        seen.delete(name);
        queued.shift();
        setTimeout(() => {
          enqueue(name);
          void pump();
        }, 700);
        continue;
      }
      queued.shift();
      const seq = cfg.nextSeq;
      await post(file, seq);
      cfg.nextSeq = seq + 1;
      sentThisSession += 1;
      await saveCfg();
      await rename(file, path.join(doneDir, name)).catch(() => {});
      say(`✓ seq ${seq} ← ${name}`);
      lastError = null;
    }
  } catch (e) {
    running = false;
    lastError = e instanceof Error ? e.message : String(e);
    say(`✗ ${lastError} — stopped; fix the cause and press Start`);
  } finally {
    pumping = false;
  }
}

async function sweepFolder() {
  for (const name of (await readdir(dir)).sort()) enqueue(name);
  void pump();
}

// -------------------------------------------------------------- web ui
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrainerDeck bridge</title><style>
body{background:#111;color:#eee;font:15px system-ui;margin:0;padding:16px;max-width:34rem}
h1{font-size:19px}h2{font-size:15px;margin:18px 0 6px;color:#9ae6b4}
input,button{font:inherit;border-radius:8px;border:1px solid #444;background:#1c1c1c;color:#eee;padding:8px 10px}
input{width:100%;box-sizing:border-box;margin:3px 0}
button{cursor:pointer;background:#065f46;border-color:#065f46;margin:4px 4px 0 0}
button.gray{background:#1c1c1c;border-color:#444}
#log{font:12px ui-monospace,monospace;white-space:pre-wrap;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px;max-height:16rem;overflow:auto}
.stat{font-size:22px;font-weight:700}.err{color:#f87171}.ok{color:#34d399}
small{color:#888}</style></head><body>
<h1>🃏 TrainerDeck scan bridge</h1>
<div id="status">loading…</div>
<h2>New stack</h2>
<input id="label" placeholder="Job label — customer name works">
<button onclick="newJob()">Create job &amp; start</button>
<h2>Controls</h2>
<button onclick="act('start')">Start</button>
<button class="gray" onclick="act('stop')">Stop</button>
<h2>Server &amp; rig key</h2>
<input id="base" placeholder="https://trainerdeck.io">
<input id="rigKey" placeholder="rig key (rk_…) — from Admin → Bulk scan" type="password">
<button class="gray" onclick="saveCfg()">Save settings</button>
<h2>Use an existing job instead</h2>
<input id="mjob" placeholder="job id">
<input id="mkey" placeholder="device key (bk_…)" type="password">
<input id="mseq" placeholder="start seq (default 1)">
<button class="gray" onclick="manual()">Use this job</button>
<h2>Log</h2><div id="log"></div>
<p><small>No login — anyone on this network can reach this page. Scanner
delivers files to the watched folder; files post in name order and move
to sent/ when delivered.</small></p>
<script>
async function j(url,opts){const r=await fetch(url,opts);const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||r.status);return b}
async function refresh(){try{const s=await j('/api/state');
document.getElementById('base').placeholder=s.base;
const jb=s.job?('<b>'+s.job.label+'</b> <small>('+s.job.id+')</small>'):'<i>no job yet</i>';
const remote=s.remote?(' · server: '+s.remote.pass1+' received, '+s.remote.verified+' verified, '+s.remote.needsReview+' review'):'';
document.getElementById('status').innerHTML=
'<div class="stat '+(s.running?'ok':'err')+'">'+(s.running?'RUNNING':'stopped')+'</div>'
+jb+'<br>next seq <b>'+s.nextSeq+'</b> · sent this session <b>'+s.sent+'</b>'+remote
+(s.lastError?'<br><span class="err">'+s.lastError+'</span>':'');
document.getElementById('log').textContent=s.log.join('\\n');
}catch(e){document.getElementById('status').innerHTML='<span class="err">'+e.message+'</span>'}}
async function saveCfg(){const base=document.getElementById('base').value.trim();const rigKey=document.getElementById('rigKey').value.trim();
await j('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({base,rigKey})});document.getElementById('rigKey').value='';refresh()}
async function newJob(){const label=document.getElementById('label').value.trim();if(!label)return alert('Give the job a label');
try{await j('/api/job',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label})});document.getElementById('label').value=''}catch(e){alert(e.message)}refresh()}
async function act(a){await j('/api/'+a,{method:'POST'});refresh()}
async function manual(){try{await j('/api/manual',{method:'POST',headers:{'content-type':'application/json'},
body:JSON.stringify({job:document.getElementById('mjob').value.trim(),key:document.getElementById('mkey').value.trim(),startSeq:document.getElementById('mseq').value.trim()})})}catch(e){alert(e.message)}refresh()}
refresh();setInterval(refresh,2500);
</script></body></html>`;

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}
const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

let remoteCache = { at: 0, data: null };
async function remoteStatus() {
  if (!cfg.job) return null;
  if (Date.now() - remoteCache.at < 5000) return remoteCache.data;
  try {
    const res = await fetch(`${cfg.base}/api/bulk/job?job=${encodeURIComponent(cfg.job.id)}`, {
      headers: { "x-bulk-key": cfg.job.key },
    });
    remoteCache = { at: Date.now(), data: res.ok ? await res.json() : null };
  } catch {
    remoteCache = { at: Date.now(), data: null };
  }
  return remoteCache.data;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, {
        base: cfg.base,
        running,
        job: cfg.job ? { id: cfg.job.id, label: cfg.job.label } : null,
        nextSeq: cfg.nextSeq,
        sent: sentThisSession,
        lastError,
        log: log.slice(-40),
        remote: await remoteStatus(),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const b = await body(req);
      if (typeof b.base === "string" && b.base.trim()) cfg.base = b.base.trim().replace(/\/+$/, "");
      if (typeof b.rigKey === "string" && b.rigKey.trim()) cfg.rigKey = b.rigKey.trim();
      await saveCfg();
      say("settings saved");
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/job") {
      const b = await body(req);
      if (!cfg.rigKey) return json(res, 400, { error: "Save the rig key first." });
      const r = await fetch(`${cfg.base}/api/bulk/job`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rig-key": cfg.rigKey },
        body: JSON.stringify({ label: b.label }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) return json(res, r.status, { error: out.error ?? "Job creation failed" });
      cfg.job = { id: out.job.id, key: out.job.device_key, label: out.job.label };
      cfg.nextSeq = 1;
      running = true;
      lastError = null;
      await saveCfg();
      say(`job "${out.job.label}" created (${out.job.id}) — feeding as it lands`);
      await sweepFolder();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/manual") {
      const b = await body(req);
      if (!b.job || !b.key) return json(res, 400, { error: "Job id and device key are required." });
      cfg.job = { id: b.job, key: b.key, label: b.job };
      cfg.nextSeq = Math.max(1, parseInt(b.startSeq ?? "1", 10) || 1);
      running = true;
      lastError = null;
      await saveCfg();
      say(`using job ${b.job} from seq ${cfg.nextSeq}`);
      await sweepFolder();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/start") {
      if (!cfg.job) return json(res, 400, { error: "No job yet — create one or paste one." });
      running = true;
      lastError = null;
      say(`started — job "${cfg.job.label}", next seq ${cfg.nextSeq}`);
      await sweepFolder();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      running = false;
      say("stopped");
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "Not found" });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(port, () => {
  console.log(`TrainerDeck bridge: web UI on http://0.0.0.0:${port} — watching ${dir}`);
});

await mkdir(doneDir, { recursive: true });
watch(dir, (_event, name) => {
  if (!name) return;
  enqueue(name);
  void pump();
});
if (cfg.job) say(`resuming job "${cfg.job.label}" at seq ${cfg.nextSeq} — press Start when ready`);
