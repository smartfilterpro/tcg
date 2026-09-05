#!/usr/bin/env node
// TrainerDeck Pi bridge: the scanning bench's appliance.
//
// Lives on a Raspberry Pi next to the document scanner and is the whole
// intake: it RUNS ITS OWN FTP SERVER (receive-only, port 2121 by
// default), so the scanner's "scan to FTP" points straight at the Pi —
// nothing else to install. Uploads land in the watch folder and post to
// the TrainerDeck bulk intake in filename order. A WEB PAGE (port 8321)
// runs the whole workflow: enter the rig key once, then per customer
// stack — type a label, tap "New job", feed the scanner, watch the
// counter climb. Scan-to-folder onto a share that maps to --dir works
// just as well; the FTP server is a convenience, not a requirement
// (--ftp-port 0 disables it, --ftp-port 21 needs root).
//
//   node scripts/pi-bridge.mjs --dir /home/pi/scans [--port 8321] [--ftp-port 2121]
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
import { createWriteStream } from "node:fs";
import net from "node:net";
import os from "node:os";
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
// Embedded FTP intake (receive-only) — the scanner's scan-to-FTP points
// straight at the Pi, no vsftpd to install. 0 disables it. Port 21 needs
// root; most scanners (PaperStream included) let you set a port, so the
// default stays unprivileged.
const ftpPort = parseInt(args["ftp-port"] ?? "2121", 10) || 0;
if (!dir) {
  console.error("Usage: node scripts/pi-bridge.mjs --dir <scan folder> [--port 8321] [--ftp-port 2121]");
  process.exit(2);
}
const CONFIG_FILE = path.resolve("pi-bridge-config.json");
const doneDir = path.join(dir, "sent");
const ftpTmpDir = path.join(dir, ".ftptmp");

// ---------------------------------------------------------------- state
const cfg = {
  base: "https://trainerdeck.io",
  rigKey: "",
  job: null, // { id, key, label }
  nextSeq: 1,
  pass: 1,
  ftpUser: "scan",
  ftpPass: "scan",
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

/** A NEW job must start from an empty folder: files a previous job left
 *  behind (a halt, a mid-stack stop) would otherwise post as the new
 *  customer's first cards. They're set aside, never deleted. */
async function archiveLeftovers() {
  const names = (await readdir(dir)).filter((n) => EXTS.has(path.extname(n).toLowerCase()));
  if (names.length === 0) return 0;
  const dest = path.join(dir, `leftover-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(dest, { recursive: true });
  for (const n of names) await rename(path.join(dir, n), path.join(dest, n)).catch(() => {});
  queued.length = 0;
  seen.clear();
  say(`⚠ ${names.length} leftover scan${names.length === 1 ? "" : "s"} set aside in ${path.basename(dest)}/`);
  return names.length;
}

// ------------------------------------------------------------------ ftp
// A deliberately tiny, receive-only FTP server: enough of RFC 959 for a
// scanner's "scan to FTP" client — login, binary mode, passive or active
// data connections, STOR. Files stream into a hidden temp dir and are
// renamed into the watch folder only when complete, so the pump never
// sees a half-written upload. Anything destructive (DELE, RETR) is
// refused; this door only opens inward.

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function safeName(raw) {
  const base = path.basename(raw.replace(/\\/g, "/")).trim();
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || `scan_${Date.now()}.jpg`;
}

function startFtp() {
  const server = net.createServer((ctrl) => {
    ctrl.setNoDelay(true);
    let user = "";
    let authed = false;
    let renameFrom = null;
    /** How the next data connection is made: {mode:"pasv",server} or
     *  {mode:"port",host,port}. */
    let data = null;
    const send = (line) => ctrl.write(`${line}\r\n`);
    send("220 TrainerDeck bridge FTP ready");

    const openData = () =>
      new Promise((resolve, reject) => {
        if (!data) return reject(new Error("no data setup"));
        if (data.mode === "port") {
          const s = net.connect(data.port, data.host, () => resolve(s));
          s.on("error", reject);
        } else {
          const srv = data.server;
          const waiting = srv.__pending;
          if (waiting) resolve(waiting);
          else {
            srv.once("connection", (s) => resolve(s));
            setTimeout(() => reject(new Error("data connection timeout")), 15000);
          }
        }
      });

    let buffer = "";
    ctrl.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        void handle(line);
      }
    });
    ctrl.on("error", () => {});
    ctrl.on("close", () => {
      if (data?.mode === "pasv") data.server.close();
    });

    async function handle(line) {
      const [cmdRaw, ...rest] = line.split(" ");
      const cmd = cmdRaw.toUpperCase();
      const arg = rest.join(" ");
      try {
        switch (cmd) {
          case "USER":
            user = arg;
            return send("331 Password required");
          case "PASS":
            authed = user === cfg.ftpUser && arg === cfg.ftpPass;
            return send(authed ? "230 Logged in" : "530 Login incorrect");
          case "SYST":
            return send("215 UNIX Type: L8");
          case "FEAT":
            return ctrl.write("211-Features\r\n UTF8\r\n PASV\r\n EPSV\r\n211 End\r\n");
          case "OPTS":
            return send("200 OK");
          case "TYPE":
            return send("200 Type set");
          case "NOOP":
            return send("200 OK");
          case "PWD":
          case "XPWD":
            return send('257 "/" is current directory');
          case "CWD":
          case "CDUP":
            return send("250 Directory changed");
          case "MKD":
          case "XMKD":
            return send(`257 "${arg || "/"}" created`);
          case "QUIT":
            send("221 Bye");
            return ctrl.end();
        }
        if (!authed) return send("530 Log in first");
        switch (cmd) {
          case "PASV": {
            if (data?.mode === "pasv") data.server.close();
            const srv = net.createServer((s) => {
              srv.__pending = s;
            });
            await new Promise((r) => srv.listen(0, r));
            data = { mode: "pasv", server: srv };
            const p = srv.address().port;
            const host = (ctrl.localAddress ?? "127.0.0.1").replace(/^::ffff:/, "");
            const h = host.includes(".") ? host.split(".").join(",") : "127,0,0,1";
            return send(`227 Entering Passive Mode (${h},${Math.floor(p / 256)},${p % 256})`);
          }
          case "EPSV": {
            if (data?.mode === "pasv") data.server.close();
            const srv = net.createServer((s) => {
              srv.__pending = s;
            });
            await new Promise((r) => srv.listen(0, r));
            data = { mode: "pasv", server: srv };
            return send(`229 Entering Extended Passive Mode (|||${srv.address().port}|)`);
          }
          case "PORT": {
            const n = arg.split(",").map((x) => parseInt(x, 10));
            if (n.length !== 6 || n.some((x) => !Number.isFinite(x))) return send("501 Bad PORT");
            data = { mode: "port", host: n.slice(0, 4).join("."), port: n[4] * 256 + n[5] };
            return send("200 PORT OK");
          }
          case "EPRT": {
            const m = /^\|(1|2)\|([^|]+)\|(\d+)\|$/.exec(arg);
            if (!m) return send("501 Bad EPRT");
            data = { mode: "port", host: m[2], port: parseInt(m[3], 10) };
            return send("200 EPRT OK");
          }
          case "LIST":
          case "NLST": {
            send("150 Here it comes");
            const s = await openData();
            s.end("");
            return send("226 Done");
          }
          case "RNFR":
            renameFrom = safeName(arg);
            return send("350 Ready for RNTO");
          case "RNTO": {
            // Some clients upload to a temp name and rename; honor it.
            if (!renameFrom) return send("503 RNFR first");
            const to = safeName(arg);
            await rename(path.join(dir, renameFrom), path.join(dir, to)).catch(() => {});
            renameFrom = null;
            return send("250 Renamed");
          }
          case "STOR": {
            const name = safeName(arg);
            send("150 Send it");
            const s = await openData();
            const tmp = path.join(ftpTmpDir, `${Date.now()}_${name}`);
            const out = createWriteStream(tmp);
            s.pipe(out);
            await new Promise((resolve, reject) => {
              s.on("end", resolve);
              s.on("error", reject);
              out.on("error", reject);
            });
            await new Promise((r) => out.end(r));
            await rename(tmp, path.join(dir, name));
            say(`ftp ← ${name}`);
            enqueue(name);
            void pump();
            return send("226 Stored");
          }
          case "DELE":
          case "RETR":
          case "RMD":
            return send("550 This server only accepts uploads");
          default:
            return send("502 Not implemented");
        }
      } catch (e) {
        return send(`451 ${e instanceof Error ? e.message : "failed"}`);
      }
    }
  });
  server.on("error", (e) => {
    say(`✗ FTP server failed: ${e.message} (is port ${ftpPort} free?)`);
  });
  server.listen(ftpPort, () => {
    say(`FTP intake on port ${ftpPort} (user "${cfg.ftpUser}") — point the scanner here`);
  });
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
<h2>Scanner login (FTP)</h2>
<div id="ftpinfo"><small>FTP disabled (--ftp-port 0)</small></div>
<input id="ftpUser" placeholder="FTP user (default: scan)">
<input id="ftpPass" placeholder="FTP password (default: scan)">
<button class="gray" onclick="saveCfg()">Save settings</button>
<h2>Use an existing job instead</h2>
<input id="mjob" placeholder="job id">
<input id="mkey" placeholder="device key (bk_…)" type="password">
<input id="mseq" placeholder="start seq (default 1)">
<button class="gray" onclick="manual()">Use this job</button>
<h2>Log</h2><div id="log"></div>
<p><small>No login — anyone on this network can reach this page. The FTP
address never changes: set the scanner once, and every scan goes to
whichever job is active here. Files post in name order and move to
sent/ when delivered; when a new job starts, anything still sitting in
the folder is set aside into a leftover-… folder, never posted or
deleted.</small></p>
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
if(s.ftp){document.getElementById('ftpinfo').innerHTML='Point the scanner at: '+
s.ftp.hosts.map(h=>'<b>ftp://'+h+':'+s.ftp.port+'</b>').join(' or ')+
' · user <b>'+s.ftp.user+'</b> · password <b>'+s.ftp.pass+'</b> · any folder path works'}
}catch(e){document.getElementById('status').innerHTML='<span class="err">'+e.message+'</span>'}}
async function saveCfg(){const base=document.getElementById('base').value.trim();const rigKey=document.getElementById('rigKey').value.trim();
const ftpUser=document.getElementById('ftpUser').value.trim();const ftpPass=document.getElementById('ftpPass').value.trim();
await j('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({base,rigKey,ftpUser,ftpPass})});
document.getElementById('rigKey').value='';document.getElementById('ftpPass').value='';refresh()}
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
        ftp:
          ftpPort > 0
            ? { port: ftpPort, user: cfg.ftpUser, pass: cfg.ftpPass, hosts: lanAddresses() }
            : null,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const b = await body(req);
      if (typeof b.base === "string" && b.base.trim()) cfg.base = b.base.trim().replace(/\/+$/, "");
      if (typeof b.rigKey === "string" && b.rigKey.trim()) cfg.rigKey = b.rigKey.trim();
      if (typeof b.ftpUser === "string" && b.ftpUser.trim()) cfg.ftpUser = b.ftpUser.trim();
      if (typeof b.ftpPass === "string" && b.ftpPass.trim()) cfg.ftpPass = b.ftpPass.trim();
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
      await archiveLeftovers();
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
await mkdir(ftpTmpDir, { recursive: true });
if (ftpPort > 0) startFtp();
watch(dir, (_event, name) => {
  if (!name) return;
  enqueue(name);
  void pump();
});
if (cfg.job) say(`resuming job "${cfg.job.label}" at seq ${cfg.nextSeq} — press Start when ready`);
