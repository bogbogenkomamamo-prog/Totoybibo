"use strict";
// Celestial Lite — auto-reply + self-react only, built to stay logged in as long as possible

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { pickBanatReply, rememberBanatReply } = require("./banat-memory");
const { chooseSocialResponse } = require("./banat-social");

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA, { recursive: true });

// ---------- tiny helpers ----------
function safeRead(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } }
function writeAtomic(f, obj) {                       // never leave a half-written cookie file behind
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const num = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };

// ---------- dashboard access ----------
// Walang password by default. Kung gusto mong i-lock, mag-set lang ng ADMIN_PASSWORD sa Railway Variables.
const hasAdmin = () => !!process.env.ADMIN_PASSWORD;
function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const checkPw = (pw) => hasAdmin() && safeEq(pw || "", process.env.ADMIN_PASSWORD);

// ---------- config ----------
const CFG_FILE = path.join(DATA, "config.json");
const DEFAULTS = {
  appState: null, savedAt: null, stateRefreshedAt: null,
  autoReply: false, threadId: null, running: false,
  speed: "normal", selfReact: true, selfReactRate: 0.15, markRead: true,
  skipRate: 0.45, senderCooldownS: 60, hourlyMax: 10, dailyMax: 60, threadMax: 3, threadWindowS: 300,
  tz: process.env.BOT_TZ || "Asia/Manila",
  openers: ["hello", "uy"],
  profile: "stealth-v1",
};
// Low-footprint profile for month-long runs. Applied ONCE to an older saved config.json
// (so the Railway volume gets updated too); after that, dashboard changes are respected.
const STEALTH_V1 = ["speed", "selfReact", "selfReactRate", "skipRate", "senderCooldownS", "hourlyMax", "dailyMax", "threadMax", "threadWindowS", "openers"];
function loadCfg() {                                 // heal: corrupt config.json -> restore from last good backup
  for (const f of [CFG_FILE, CFG_FILE + ".bak"]) {
    if (!fs.existsSync(f)) continue;
    try { const o = JSON.parse(fs.readFileSync(f, "utf8")); if (f !== CFG_FILE) console.log("[heal] config.json was corrupt, restored from backup"); return o; }
    catch (e) { console.log("[heal] cannot read " + path.basename(f) + ": " + e.message); }
  }
  return {};
}
const cfg = Object.assign({}, DEFAULTS, loadCfg());
delete cfg.quiet;                                  // quiet hours removed
if (cfg.profile !== DEFAULTS.profile) {
  for (const k of STEALTH_V1) cfg[k] = DEFAULTS[k];
  cfg.profile = DEFAULTS.profile;
  try { writeAtomic(CFG_FILE, cfg); } catch {}
}
const save = () => { try { try { JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); fs.copyFileSync(CFG_FILE, CFG_FILE + ".bak"); } catch {} writeAtomic(CFG_FILE, cfg); } catch (e) { console.error("[save]", e.message); } };

// ---------- reply pools (replies.json: array OR { type: [..], default: [..] }) ----------
let RAW_POOL;
try { RAW_POOL = JSON.parse(fs.readFileSync(path.join(__dirname, "replies.json"), "utf8")); }
catch (e) { console.log("[heal] replies.json unreadable (" + e.message + "), using built-in fallback"); RAW_POOL = { default: ["hmm", "ah ganun", "ganun ba", "ganun pala", "ah i see"] }; }
const POOLS = Array.isArray(RAW_POOL) ? { default: RAW_POOL } : RAW_POOL;
const ALL_REPLIES = [...new Set(Object.values(POOLS).flat())];
const poolKey = (type) => (Array.isArray(POOLS[type]) && POOLS[type].length ? type : "default");
const poolFor = (type) => (Array.isArray(POOLS[poolKey(type)]) && POOLS[poolKey(type)].length ? POOLS[poolKey(type)] : ALL_REPLIES);

// ---------- runtime state ----------
const S = {
  api: null, uid: null, online: false, running: false, logging: false, stopListen: null, manualOff: false,
  authDead: false, started: Date.now(), botSince: null, lastConnected: null, lastDisconnected: null,
  attempts: 0, nextRetry: null, timer: null, listenTimer: null, listenFails: 0, pingFails: 0,
  lastEventAt: null, lastPing: null, nextPing: 0, lastStateJson: cfg.appState ? JSON.stringify(cfg.appState) : null,
  lastError: null, replies: [], daily: [], suppressed: 0, awayUntil: 0,
  heat: 0, heatUntil: 0, pauseUntil: 0, sendFails: 0, busyAt: new Map(), loginAt: 0, relistenAt: 0, lastSoft: 0, wdFixes: 0, wdLast: null, lastReset: 0, errLog: [], fatals: [], triedBackup: false,
  senders: new Map(), threads: new Map(), busy: new Set(), log: [],
};

function log(who, msg) {
  S.log.unshift({ t: Date.now(), who, msg: String(msg).slice(0, 300) });
  S.log.length = Math.min(S.log.length, 80);
  console.log(`[${who}] ${msg}`);
}

function parseCookie(raw) {
  raw = String(raw || "").trim();
  const arr = raw.startsWith("[")
    ? JSON.parse(raw)
    : raw.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
        const i = p.indexOf("=");
        return { key: p.slice(0, i), value: p.slice(i + 1), domain: "facebook.com", path: "/", hostOnly: false };
      });
  const keys = new Set(arr.map((c) => c.key || c.name));
  if (!keys.has("c_user") || !keys.has("xs")) throw new Error("missing c_user / xs");
  return arr;
}

// ---------- session keep-alive: the part that decides how long a login survives ----------
const AUTH_RE = /checkpoint|not logged in|login[_ ]?(approval|blocked)|expired|appstate|retrieving userid|unknown location|suspended|disabled|locked|invalid.*(cookie|session)/i;
const isAuthError = (e) => AUTH_RE.test(String((e && (e.error || e.message)) || e || ""));

// Facebook rotates parts of the session while you use it. Saving the refreshed
// appState (instead of the original paste) is what lets a login keep working
// across restarts for weeks.
function captureState(reason) {
  if (!S.api || typeof S.api.getAppState !== "function") return;
  try {
    const st = S.api.getAppState();
    if (!Array.isArray(st) || !st.length) return;
    const json = JSON.stringify(st);
    if (json === S.lastStateJson) return;
    if (cfg.appState) { try { writeAtomic(path.join(DATA, "appstate.backup.json"), cfg.appState); } catch {} }
    S.lastStateJson = json; cfg.appState = st; cfg.stateRefreshedAt = Date.now(); save();
    log("session", `cookie refreshed (${reason})`);
  } catch (e) { log("error", "getAppState: " + (e.message || e)); }
}

function stopListening() {
  const s = S.stopListen; S.stopListen = null;
  clearTimeout(S.listenTimer);
  try {
    if (typeof s === "function") s();
    else if (s && typeof s.stopListening === "function") s.stopListening();
    else if (s && typeof s.stop === "function") s.stop();
  } catch {}
}
function teardown() { stopListening(); S.api = null; S.online = false; S.busy.clear(); }

function markAuthDead(e) {
  S.authDead = true;
  S.lastError = "Session expired / checkpoint — paste a fresh cookie. (" + String((e && (e.error || e.message)) || e).slice(0, 120) + ")";
  log("watchdog", "auth problem: auto-retry paused so the account isn't hammered");
  teardown(); S.lastDisconnected = Date.now(); clearTimeout(S.timer); S.nextRetry = null;
}

function connect() {
  if (S.logging || !cfg.appState || S.authDead) return;
  clearTimeout(S.timer); S.nextRetry = null; S.logging = true; S.loginAt = Date.now();
  let login;
  try { login = require("@dongdev/fca-unofficial"); }
  catch (e) { S.logging = false; return log("error", "fca library missing: " + e.message); }

  login({ appState: cfg.appState }, { online: true, selfListen: false, listenEvents: true, autoMarkRead: false, logLevel: "error" }, (err, api) => {
    S.logging = false;
    if (err) {
      S.lastError = String(err.message || err.error || err);
      log("error", "login: " + S.lastError);
      if (isAuthError(err)) return tryCookieBackup(err) || markAuthDead(err);
      selfHeal("login", err);
      return scheduleRetry();
    }
    S.api = api; S.uid = String(api.getCurrentUserID()); S.online = true; S.triedBackup = false; S.attempts = 0; S.listenFails = 0; S.pingFails = 0;
    S.lastConnected = Date.now(); S.lastError = null; S.nextPing = Date.now() + rnd(10, 20) * 60e3;
    log("system", "Messenger connected as " + S.uid);
    captureState("login");
    if (cfg.running && !S.running) { S.running = true; S.botSince = Date.now(); log("bot", "resumed after reconnect"); }
    startListen();
  });
}

function startListen() {
  if (!S.api) return;
  stopListening();
  S.stopListen = S.api.listenMqtt((e, ev) => {
    if (e) return onListenError(e);
    S.listenFails = 0; S.lastEventAt = Date.now();
    onEvent(ev).catch((err) => { log("error", "event: " + (err && err.message || err)); selfHeal("event", err); });
  });
}
function onListenError(e) {
  log("error", "listen: " + (e.message || e.error || e));
  selfHeal("listen", e);
  if (isAuthError(e)) return markAuthDead(e);
  S.listenFails++;
  if (S.listenFails <= 3) {                          // try to re-listen on the SAME login first; fresh logins look suspicious
    clearTimeout(S.listenTimer);
    const wait = 4000 * S.listenFails + rnd(0, 2000); S.relistenAt = Date.now() + wait;
    S.listenTimer = setTimeout(startListen, wait);
    return;
  }
  drop();
}
function drop() { teardown(); S.lastDisconnected = Date.now(); scheduleRetry(); }
function scheduleRetry() {
  if (!cfg.appState || S.manualOff || S.authDead) return;
  S.attempts++;
  let s = Math.min(300, 3 * 2 ** (S.attempts - 1)) + rnd(0, 2);   // 3s, 6s, 12s ... capped at 5 min
  if (S.attempts > 10) { s = 1800; S.attempts = 0; log("watchdog", "Gave up after 10 tries. Will retry in 30 min"); }
  else log("watchdog", `reconnect #${S.attempts} in ${Math.round(s)}s`);
  S.nextRetry = Date.now() + s * 1000; clearTimeout(S.timer); S.timer = setTimeout(connect, s * 1000);
}
function disconnect() {
  S.manualOff = true; clearTimeout(S.timer); teardown();
  S.running = false; cfg.running = false; save(); S.lastDisconnected = Date.now(); S.nextRetry = null;
}

// Light health check every 20-40 min: detects a dead session early and keeps the cookie fresh.
function ping() {
  if (!S.api) return;
  S.api.getThreadList(1, null, ["INBOX"], (e) => {
    if (!e) { S.pingFails = 0; S.lastPing = Date.now(); return; }
    if (isAuthError(e)) return markAuthDead(e);
    if (++S.pingFails >= 3) { log("watchdog", "health check failed 3x, reconnecting"); S.pingFails = 0; drop(); }
  });
}
setInterval(() => {
  if (!S.api) return;
  captureState("periodic");
  if (Date.now() >= S.nextPing) { S.nextPing = Date.now() + rnd(20, 40) * 60e3; ping(); }
}, 5 * 60e3);

// ---------- auto health watchdog + auto debuff ----------
// Watchdog: checks every minute and quietly repairs stuck states (no spam, no hammering the account).
// Debuff: when sends start failing or Facebook hints at limits, the bot automatically slows itself
// down (lower caps, more skips, longer cooldowns) and pauses at the worst level, then recovers by itself.
const HEAT_STEP_MS = 3 * 3600e3, PAUSE_MS = 2 * 3600e3;
const RISK_RE = /spam|block|limit|rate|try again later|temporar|restrict|suspicious|too (many|fast)|slow down/i;
function wdFix(msg, who) { S.wdFixes++; S.wdLast = { t: Date.now(), msg }; log(who || "watchdog", msg); }
function heatUp(n, why) {
  S.heat = Math.min(3, S.heat + n); S.heatUntil = Date.now() + HEAT_STEP_MS;
  if (S.heat >= 3) { S.pauseUntil = Date.now() + PAUSE_MS; log("debuff", `level 3 (${why}) — paused 2h`); }
  else log("debuff", `level ${S.heat} (${why}) — slowing down`);
}
function onSendResult(err) {
  if (!err) { S.sendFails = 0; return; }
  const msg = String(err.error || err.message || err);
  S.lastError = "send: " + msg.slice(0, 120);
  if (RISK_RE.test(msg) && !/checkpoint|not logged in|expired|appstate|login|disabled|suspended/i.test(msg)) return heatUp(2, "Facebook limit hint");
  if (isAuthError(err)) return markAuthDead(err);
  if (++S.sendFails >= 3) { S.sendFails = 0; heatUp(1, "3 send fails in a row"); }
}
const eff = () => {                                  // effective limits after debuff
  const h = S.heat;
  return {
    hourly: Math.max(1, Math.floor(cfg.hourlyMax / (1 + h))), daily: Math.max(1, Math.floor(cfg.dailyMax / (1 + h))),
    skip: Math.min(0.9, cfg.skipRate + 0.15 * h), cooldown: cfg.senderCooldownS * (1 + h),
  };
};
function watchdog() {
  const now = Date.now();
  const rss = process.memoryUsage().rss / 1048576;
  if (rss > MAX_RSS_MB) return restartProcess(`memory ${Math.round(rss)}MB > ${MAX_RSS_MB}MB`);
  for (const [t, at] of S.busyAt) if (now - at > 60e3) { S.busy.delete(t); S.busyAt.delete(t); wdFix("stuck reply lock cleared"); }
  if (S.heat > 0 && now > S.heatUntil && now > S.pauseUntil) { S.heat--; S.heatUntil = now + HEAT_STEP_MS; log("debuff", `cooling down → level ${S.heat}`); }
  if (S.authDead || S.manualOff || !cfg.appState) return;
  if (S.logging && now - S.loginAt > 60e3) { S.logging = false; wdFix("login hung >60s, retrying"); return scheduleRetry(); }
  if (!S.online && !S.logging) {
    if (!S.nextRetry) { wdFix("no reconnect scheduled, scheduling now"); return scheduleRetry(); }
    if (now > S.nextRetry + 60e3) { wdFix("reconnect timer lost, connecting now"); return connect(); }
    return;
  }
  if (!S.online) return;
  if (!S.stopListen && !(S.relistenAt && now < S.relistenAt + 10e3)) { wdFix("listener was missing, restarted"); return startListen(); }
  const ref = S.lastEventAt || S.lastConnected || now;
  if (S.running && now - ref > 3 * 3600e3 && now - S.lastSoft > 6 * 3600e3) {
    S.lastSoft = now; wdFix("no events for 3h, refreshing listener on same login"); startListen();
  }
}

// ---------- auto heal: the bot diagnoses its own errors and applies the matching fix ----------
const NET_RE = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|timed? ?out|getaddrinfo/i;
const CODE_RE = /TypeError|ReferenceError|RangeError|SyntaxError|Cannot read|is not a function|is not defined|undefined/i;
const MAX_RSS_MB = Number(process.env.MAX_RSS_MB) || 600;

function restartProcess(reason) {                    // clean self-restart; the host (Railway) brings it back up
  log("heal", "restarting process: " + reason);
  try { captureState("self-restart"); save(); } catch {}
  setTimeout(() => process.exit(1), 500);
}
function softReset(reason) {                         // rebuild the connection from scratch on the SAME cookie
  const now = Date.now();
  if (now - S.lastReset < 30 * 60e3) return false;   // never reset more than once per 30 min
  S.lastReset = now; captureState("pre-reset");
  teardown(); S.busyAt.clear(); S.senders.clear(); S.threads.clear(); S.listenFails = 0; S.pingFails = 0; S.attempts = 0;
  wdFix("self-heal: connection reset (" + reason + ")", "heal");
  if (!S.manualOff && !S.authDead && cfg.appState) { clearTimeout(S.timer); S.nextRetry = Date.now() + 4000; S.timer = setTimeout(connect, 1500 + rnd(0, 2000)); }
  return true;
}
function tryCookieBackup(err) {                      // heal: current cookie rejected -> try the previous good one, once
  if (S.triedBackup) return false;
  try {
    const bk = JSON.parse(fs.readFileSync(path.join(DATA, "appstate.backup.json"), "utf8"));
    if (!Array.isArray(bk) || !bk.length || JSON.stringify(bk) === JSON.stringify(cfg.appState)) return false;
    S.triedBackup = true; cfg.appState = bk; S.lastStateJson = JSON.stringify(bk); save();
    wdFix("self-heal: cookie rejected, trying previous cookie backup", "heal");
    setTimeout(connect, 1000 + rnd(0, 1000)); return true;
  } catch { return false; }
}
function selfHeal(source, e) {                       // classify -> apply the right fix (or deliberately do nothing)
  const now = Date.now();
  const text = (e && e.name && e.name !== "Error" ? e.name + ": " : "") + String((e && (e.message || e.error)) || e);
  if (AUTH_RE.test(text) || NET_RE.test(text)) return;   // auth = handled by the session logic; network = transient, backoff already covers it
  const cls = CODE_RE.test(text) ? "code" : "other";
  const key = text.replace(/\d+/g, "#").slice(0, 80);
  S.errLog = S.errLog.filter((x) => now - x.t < 600e3).slice(-200); S.errLog.push({ t: now, k: key, cls });
  const same = S.errLog.filter((x) => x.k === key).length;
  if ((cls === "code" && same >= 3) || same >= 6) { if (softReset(`repeated ${cls} error: ${key.slice(0, 60)}`)) S.errLog = []; }
  if (source === "fatal") {
    S.fatals = S.fatals.filter((t) => now - t < 600e3); S.fatals.push(now);
    if (S.fatals.length >= 10) restartProcess("10 fatal errors in 10 min");
  }
}
setInterval(() => { try { watchdog(); } catch (e) { log("error", "watchdog: " + (e.message || e)); } }, 60e3);

// ---------- Bot ----------
const sendRaw = (api, text, tid, cb, replyTo) => api.sendMessage(text, tid, (err, info) => { try { onSendResult(err); } catch {} if (cb) cb(err, info); }, replyTo || undefined);

function allowed(ev) {                               // anti-spam gate
  const now = Date.now();
  S.replies = S.replies.filter((t) => now - t < 3600e3);
  S.daily = S.daily.filter((t) => now - t < 86400e3);
  const e = eff();
  if (S.replies.length >= e.hourly || S.daily.length >= e.daily) return false;
  if (now - (S.senders.get(ev.senderID) || 0) < e.cooldown * 1000) return false;
  const th = (S.threads.get(ev.threadID) || []).filter((t) => now - t < cfg.threadWindowS * 1000);
  S.threads.set(ev.threadID, th);
  if (S.senders.size > 2000) for (const [k, t] of S.senders) if (now - t > 3600e3) S.senders.delete(k);
  if (S.threads.size > 500) for (const [k, v] of S.threads) if (!v.length) S.threads.delete(k);
  return th.length < cfg.threadMax;
}

async function onEvent(ev) {
  if (!ev) return;
  if ((ev.type !== "message" && ev.type !== "message_reply") || !ev.body || String(ev.senderID) === S.uid || !S.running) return;
  const target = cfg.autoReply || (cfg.threadId && ev.threadID === cfg.threadId);
  if (!target) return;
  if (Date.now() < S.pauseUntil) return;            // debuff level 3: full pause
  if (Date.now() < S.awayUntil) return;              // "away" break: a real person isn't glued to the phone
  if (Math.random() < eff().skip) return;            // random skip (higher while debuffed)
  if (S.busy.has(ev.threadID)) return;               // don't talk over ourselves in the same chat
  if (!allowed(ev)) { S.suppressed++; return; }

  const api = S.api;
  if (!api) return;
  S.busy.add(ev.threadID); S.busyAt.set(ev.threadID, Date.now());
  try {
    const social = chooseSocialResponse(ev.body, "", { momentum: 1, recentMessages: 1 });
    const key = poolKey(social.type);
    const r = pickBanatReply(ev.threadID, poolFor(social.type), [], "reply-pool:" + key);
    const text = typeof r === "string" && r ? r : ALL_REPLIES[Math.floor(Math.random() * ALL_REPLIES.length)];

    const now = Date.now();
    S.replies.push(now); S.daily.push(now); S.senders.set(ev.senderID, now); S.threads.get(ev.threadID).push(now);

    if (cfg.markRead && typeof api.markAsRead === "function") {   // "seen" shortly after it arrives, like a person
      setTimeout(() => { try { api.markAsRead(ev.threadID, true, () => {}); } catch {} }, rnd(250, 1200));
    }

    const ok = await Promise.race([sendBanatReplyWithTyping(api, text, ev.threadID, null, {
      trafficSendMessage: sendRaw,
      incomingText: ev.body,
      speed: cfg.speed,
      selfReact: cfg.selfReact ? { rate: cfg.selfReactRate } : false,   // only reacts to its OWN replies
    }), sleep(45000).then(() => { onSendResult(new Error("send timeout")); return false; })]);
    if (ok) {
      rememberBanatReply(ev.threadID, text, ev.senderID); log("bot", `reply [${social.type}] -> ${ev.threadID}`);
      if (Math.random() < 0.06) { S.awayUntil = Date.now() + rnd(20, 90) * 60e3; log("bot", `away break ${Math.round((S.awayUntil - Date.now()) / 60e3)} min`); }
    }
  } finally { S.busy.delete(ev.threadID); S.busyAt.delete(ev.threadID); }
}

async function startBot() {
  if (!S.online) return log("error", "Connect first");
  S.running = true; cfg.running = true; save(); S.botSince = Date.now(); log("bot", "started");
  if (cfg.threadId) {
    const o = cfg.openers[Math.floor(Math.random() * cfg.openers.length)];
    sendBanatReplyWithTyping(S.api, o, cfg.threadId, null, { trafficSendMessage: sendRaw, incomingText: "", speed: cfg.speed, selfReact: false });
  }
}

// ---------- HTTP ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.get("/", (q, r) => r.sendFile(path.join(__dirname, "index.html")));   // only index.html is public
app.get("/health", (q, r) => r.json({ ok: true }));

app.get("/api/needsetup", (q, r) => r.json({ setup: false, open: !hasAdmin() }));

const fails = new Map();
app.use("/api", (req, res, next) => {
  if (!hasAdmin()) return next();                   // open dashboard (walang password)
  const ip = req.ip, now = Date.now(), given = req.get("x-admin");
  const f = (fails.get(ip) || []).filter((t) => now - t < 900e3);
  if (f.length >= 10) return res.status(429).json({ error: "Too many wrong tries. Wait 15 min." });
  if (hasAdmin() && given !== undefined && checkPw(given)) { fails.delete(ip); return next(); }
  if (given !== undefined) { f.push(now); fails.set(ip, f); }
  if (fails.size > 500) for (const [k, v] of fails) if (!v.some((t) => now - t < 900e3)) fails.delete(k);
  res.status(401).json({ error: "unauthorized" });
});

const status = () => ({
  online: S.online, logging: S.logging, running: S.running, uid: S.uid, authDead: S.authDead,
  serverUptime: (Date.now() - S.started) / 1000 | 0, botUptime: S.running && S.botSince ? (Date.now() - S.botSince) / 1000 | 0 : 0,
  lastConnected: S.lastConnected, lastDisconnected: S.lastDisconnected, lastPing: S.lastPing, lastEventAt: S.lastEventAt,
  stateRefreshedAt: cfg.stateRefreshedAt, savedAt: cfg.savedAt,
  autoReply: cfg.autoReply, threadId: cfg.threadId, repliesHour: S.replies.length, repliesDay: S.daily.length, suppressed: S.suppressed,
  attempts: S.attempts, nextRetry: S.nextRetry, lastError: S.lastError, cookieSaved: !!cfg.appState,
  settings: {
    speed: cfg.speed, selfReact: cfg.selfReact, selfReactRate: cfg.selfReactRate, markRead: cfg.markRead,
    skipRate: cfg.skipRate, hourlyMax: cfg.hourlyMax, dailyMax: cfg.dailyMax, quiet: { on: false, start: "00:00", end: "00:00" }, tz: cfg.tz,
  },
  heat: S.heat, paused: Date.now() < S.pauseUntil, pauseUntil: S.pauseUntil, wdFixes: S.wdFixes, wdLast: S.wdLast,
  quietNow: false, log: S.log.slice(0, 40),
});
app.get("/api/status", (q, r) => r.json(status()));
app.post("/api/auto", (q, r) => { cfg.autoReply = !!q.body.on; save(); r.json(status()); });
app.post("/api/thread", (q, r) => { cfg.threadId = q.body.threadId || null; save(); r.json(status()); });
app.post("/api/start", async (q, r) => { await startBot(); r.json(status()); });
app.post("/api/stop", (q, r) => { S.running = false; cfg.running = false; save(); log("bot", "stopped"); r.json(status()); });
app.post("/api/reconnect", (q, r) => {
  S.manualOff = false; S.authDead = false; if (S.online) { teardown(); }
  S.attempts = 0; clearTimeout(S.timer); connect(); r.json(status());
});
app.post("/api/disconnect", (q, r) => { disconnect(); r.json(status()); });
app.post("/api/session", (q, r) => {
  try {
    cfg.appState = parseCookie(q.body.cookie); cfg.savedAt = Date.now(); cfg.stateRefreshedAt = null; S.lastStateJson = JSON.stringify(cfg.appState); save();
    S.manualOff = false; S.authDead = false; S.attempts = 0; S.lastError = null; S.triedBackup = false;
    if (S.online) teardown();
    connect(); r.json(status());
  } catch (e) { r.status(400).json({ error: "Invalid cookie (need a JSON array or c_user=...; xs=...)" }); }
});
app.post("/api/settings", (q, r) => {
  const b = q.body || {};
  if (["fast", "normal", "slow"].includes(b.speed)) cfg.speed = b.speed;
  if (typeof b.selfReact === "boolean") cfg.selfReact = b.selfReact;
  if (typeof b.markRead === "boolean") cfg.markRead = b.markRead;
  cfg.selfReactRate = num(b.selfReactRate, 0, 1, cfg.selfReactRate);
  cfg.skipRate = num(b.skipRate, 0, 0.9, cfg.skipRate);
  cfg.hourlyMax = Math.round(num(b.hourlyMax, 1, 300, cfg.hourlyMax));
  cfg.dailyMax = Math.round(num(b.dailyMax, 1, 3000, cfg.dailyMax));
  save(); log("system", "settings updated"); r.json(status());
});
app.get("/api/threads", (q, r) => {
  if (!S.api) return r.json([]);
  S.api.getThreadList(50, null, ["INBOX"], (e, l) => r.json(e ? [] : l.filter((t) => t.isGroup).map((t) => ({ id: t.threadID, name: t.name || t.threadID }))));
});

// A month-long process must not die on one stray exception, and must save the
// freshest cookie when the host (Railway) sends SIGTERM on redeploy.
process.on("uncaughtException", (e) => { log("fatal", (e && e.stack) || e); try { selfHeal("fatal", e); } catch {} });
process.on("unhandledRejection", (e) => { log("fatal", (e && e.stack) || e); try { selfHeal("fatal", e); } catch {} });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { captureState("shutdown"); save(); process.exit(0); });

// =====================================================================================
// UNKILLABLE ADD-ON — additive only. Walang binago sa existing functions sa taas.
// Adds: file log + rotation, crash-loop guard, counters/heat persistence, cookie generations,
// event-loop stall watchdog, zombie-connection detector, capped auth soft-retry,
// http hardening, /healthz, crash trail, exit hook, signal/pipe hardening, optional self-ping.
// =====================================================================================
(function unkillable() {
  const HOUR = 3600e3;
  const P = (f) => path.join(DATA, f);
  const tryDo = (fn, tag) => { try { return fn(); } catch (e) { try { process.stderr.write("[addon:" + tag + "] " + (e && e.message) + "\n"); } catch {} } };

  // 0) leftover half-written files from a hard kill
  tryDo(() => { for (const f of fs.readdirSync(DATA)) if (f.endsWith(".tmp")) fs.unlinkSync(P(f)); }, "tmp");

  // 1) persistent log file (bot.log, rotates at ~1MB, keeps 3) — mirrors console output
  const LOG = P("bot.log"); let wc = 0;
  const wrap = (name) => {
    const orig = console[name].bind(console);
    console[name] = (...a) => {
      orig(...a);
      tryDo(() => {
        const line = a.map((x) => (typeof x === "string" ? x : (x && x.stack) || JSON.stringify(x))).join(" ");
        fs.appendFile(LOG, new Date().toISOString() + " " + line + "\n", () => {});
        if (++wc % 200 === 0 && fs.statSync(LOG).size > 1048576) {
          for (let i = 2; i >= 1; i--) if (fs.existsSync(LOG + "." + i)) fs.renameSync(LOG + "." + i, LOG + "." + (i + 1));
          fs.renameSync(LOG, LOG + ".1");
        }
      }, "log");
    };
  };
  wrap("log"); wrap("error");

  // 2) boot report + crash-loop guard (pinipigilan ang login-spam kapag paulit-ulit na nagre-restart)
  tryDo(() => {
    const now = Date.now();
    const boots = (safeRead(P("boots.json")).t || []).filter((t) => now - t < 600e3); boots.push(now);
    writeAtomic(P("boots.json"), { t: boots });
    const hb = safeRead(P("heartbeat.json"));
    if (hb.ts) console.log("[addon] boot — down ~" + Math.round((now - hb.ts) / 1000) + "s since last heartbeat" + (hb.clean ? " (clean stop)" : " (unclean stop)"));
    if (boots.length >= 4) {
      const w = Math.min(20000, 5000 * (boots.length - 3));
      console.log("[addon] crash-loop (" + boots.length + " boots/10min), waiting " + w / 1000 + "s before login");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, w);   // server not listening yet, safe to block
    }
  }, "boot");

  // 3) persist send counters + heat/pause/away so a restart can't reset the safety limits
  const persist = () => tryDo(() => writeAtomic(P("runtime.json"), {
    replies: S.replies, daily: S.daily, heat: S.heat, heatUntil: S.heatUntil, pauseUntil: S.pauseUntil, awayUntil: S.awayUntil, at: Date.now(),
  }), "persist");
  tryDo(() => {
    const r = safeRead(P("runtime.json")), now = Date.now();
    if (Array.isArray(r.replies)) S.replies = r.replies.filter((t) => now - t < HOUR);
    if (Array.isArray(r.daily)) S.daily = r.daily.filter((t) => now - t < 24 * HOUR);
    for (const k of ["heat", "heatUntil", "pauseUntil", "awayUntil"]) if (Number.isFinite(r[k])) S[k] = r[k];
  }, "restore");

  // 4) cookie generations: last 5 DIFFERENT cookies that were actually online
  const GEN = 5; let lastGen = null;
  tryDo(() => { lastGen = JSON.stringify(safeRead(P("appstate.gen1.json"))); }, "gen-init");
  const saveGen = () => tryDo(() => {
    if (!S.online || !Array.isArray(cfg.appState) || !cfg.appState.length) return;
    const j = JSON.stringify(cfg.appState); if (j === lastGen) return; lastGen = j;
    for (let i = GEN - 1; i >= 1; i--) if (fs.existsSync(P("appstate.gen" + i + ".json"))) fs.renameSync(P("appstate.gen" + i + ".json"), P("appstate.gen" + (i + 1) + ".json"));
    writeAtomic(P("appstate.gen1.json"), cfg.appState);
  }, "gen");
  // if config lost its cookie (wiped volume / corrupt), restore the newest saved one
  tryDo(() => {
    if (cfg.appState) return;
    for (const f of ["appstate.gen1.json", "appstate.backup.json", "appstate.gen2.json", "appstate.gen3.json", "appstate.gen4.json", "appstate.gen5.json"]) {
      const a = safeRead(P(f));
      if (Array.isArray(a) && a.length) { cfg.appState = a; S.lastStateJson = JSON.stringify(a); save(); console.log("[addon] cookie restored from " + f); break; }
    }
  }, "cookie-restore");

  // 5) event-loop stall watchdog: 3 ticks in a row with >8s lag = frozen process -> clean restart
  let lastTick = Date.now(), lagHits = 0;
  setInterval(() => {
    const now = Date.now(), lag = now - lastTick - 1000; lastTick = now;
    lagHits = lag > 8000 ? lagHits + 1 : 0;
    if (lagHits >= 3) { lagHits = 0; restartProcess("event loop stalled (" + Math.round(lag / 1000) + "s lag x3)"); }
  }, 1000).unref();

  // 6) 30s supervisor: heartbeat, persistence, cookie gens, zombie detector, capped auth soft-retry
  const AUTH_RETRY_MS = (Number(process.env.AUTH_RETRY_HOURS) || 6) * HOUR;
  let tick = 0, deadAt = 0, authTries = 0;
  setInterval(() => tryDo(() => {
    const now = Date.now(); tick++;
    tryDo(() => writeAtomic(P("heartbeat.json"), { ts: now, clean: false, online: S.online, running: S.running }), "hb");
    if (tick % 2 === 0) { persist(); saveGen(); }

    // zombie: "online" pero walang successful ping/connect nang >2h (hung callback, silent MQTT)
    if (S.online && !S.logging) {
      const ref = Math.max(S.lastPing || 0, S.lastConnected || 0);
      if (ref && now - ref > 2 * HOUR) { console.log("[addon] zombie connection (no ping 2h) -> reconnect"); drop(); }
    }

    // auth marked dead (misclassified errors happen): up to 3 gentle retries, 6h apart, then wait for a fresh cookie
    if (S.authDead && !S.manualOff && cfg.appState) {
      if (!deadAt) deadAt = now;
      if (authTries < 3 && now - deadAt > AUTH_RETRY_MS * (authTries + 1)) {
        authTries++;
        console.log("[addon] auth dead for " + Math.round((now - deadAt) / HOUR) + "h — soft retry " + authTries + "/3 on same cookie");
        S.authDead = false; S.triedBackup = false; S.attempts = 0; connect();
      }
    } else if (S.online) { deadAt = 0; authTries = 0; }
  }, "supervisor"), 30e3).unref();

  // 7) HTTP hardening + /healthz (point UptimeRobot/Railway healthcheck here)
  const _listen = app.listen.bind(app);
  app.listen = (...a) => {
    const srv = _listen(...a);
    srv.keepAliveTimeout = 65e3; srv.headersTimeout = 70e3; srv.requestTimeout = 30e3;
    srv.on("clientError", (e, sock) => { try { sock.destroy(); } catch {} });
    srv.on("error", (e) => { console.error("[addon] http server error: " + (e && e.message)); setTimeout(() => restartProcess("http server error " + (e && e.code)), 3000); });
    return srv;
  };
  app.get("/healthz", (q, r) => r.json({
    ok: true, online: S.online, running: S.running, authDead: S.authDead, heat: S.heat,
    idleMin: S.lastEventAt ? Math.round((Date.now() - S.lastEventAt) / 60e3) : null,
    rssMB: Math.round(process.memoryUsage().rss / 1048576), upS: Math.round(process.uptime()),
  }));
  app.use((err, q, r, next) => {                      // eslint-disable-line no-unused-vars
    console.error("[addon] express: " + (err && err.message));
    if (!r.headersSent) r.status((err && err.status) || 500).json({ error: "server error" });
  });

  // 8) crash trail, exit hook, signals
  const crash = (tag) => (e) => tryDo(() => {
    const f = P("crash.log");
    try { if (fs.statSync(f).size > 524288) fs.unlinkSync(f); } catch {}
    fs.appendFileSync(f, new Date().toISOString() + " " + tag + " " + ((e && e.stack) || e) + "\n");
  }, "crash");
  process.on("uncaughtException", crash("uncaughtException"));
  process.on("unhandledRejection", crash("unhandledRejection"));
  process.on("exit", (code) => tryDo(() => {
    captureState("exit"); persist();
    writeAtomic(P("heartbeat.json"), { ts: Date.now(), clean: code === 0, online: false });
  }, "exit"));
  process.on("SIGHUP", () => console.log("[addon] SIGHUP ignored (terminal closed)"));
  process.stdout.on("error", () => {}); process.stderr.on("error", () => {});   // EPIPE shouldn't kill us

  // 9) optional keep-awake for hosts that sleep idle apps (set SELF_URL, or Render sets RENDER_EXTERNAL_URL)
  const SELF = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  if (SELF && typeof fetch === "function") {
    setInterval(() => { fetch(SELF + "/health", { signal: AbortSignal.timeout(15000) }).catch(() => {}); }, 4 * 60e3).unref();
  }

  console.log("[addon] unkillable layer active");
})();

// =====================================================================================
// FAST-LOGIN + 1-WEEK COOKIE LAYER — additive only. Walang binago sa existing functions.
// Adds: login timer log, early cookie capture after login, cookie expiry floor (>= COOKIE_MIN_DAYS),
// volume mirror of the cookie, APPSTATE env seed, one fast first-retry on network blips,
// boot warnings if the cookie can't survive a redeploy.
// =====================================================================================
(function sessionLayer() {
  const DAY = 86400e3;
  const MIN_DAYS = Number(process.env.COOKIE_MIN_DAYS) || 7;
  const tryDo = (fn, tag) => { try { return fn(); } catch (e) { try { process.stderr.write("[session:" + tag + "] " + (e && e.message) + "\n"); } catch {} } };

  // ---- where the cookie can survive a redeploy ----
  const MIRROR = process.env.MIRROR_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || "";
  const MIR = MIRROR && path.resolve(MIRROR) !== path.resolve(DATA) ? path.join(MIRROR, "celestial-session") : null;
  if (MIR) tryDo(() => fs.mkdirSync(MIR, { recursive: true }), "mirror-dir");

  tryDo(() => {
    const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    if (vol && !path.resolve(DATA).startsWith(path.resolve(vol))) {
      console.log("[session] WARNING: DATA_DIR is not on the Railway volume (" + vol + "). Set DATA_DIR=" + vol + " so the cookie survives redeploys. Mirror copy is active as backup.");
    } else if (!vol && process.env.RAILWAY_ENVIRONMENT && !process.env.DATA_DIR) {
      console.log("[session] WARNING: no volume attached — the saved cookie is wiped on every redeploy. Add a Railway volume and set DATA_DIR to its mount path, or set the APPSTATE variable.");
    }
  }, "vol-warn");

  // ---- cookie recovery chain at boot (config -> gens [addon 1] -> volume mirror -> APPSTATE env) ----
  tryDo(() => {
    if (cfg.appState || !MIR) return;
    const m = safeRead(path.join(MIR, "appstate.json"));
    if (Array.isArray(m.state) && m.state.length) { cfg.appState = m.state; S.lastStateJson = JSON.stringify(m.state); save(); console.log("[session] cookie restored from volume mirror"); }
  }, "mirror-restore");
  tryDo(() => {
    if (cfg.appState || !process.env.APPSTATE) return;
    cfg.appState = parseCookie(process.env.APPSTATE); cfg.savedAt = Date.now(); S.lastStateJson = JSON.stringify(cfg.appState); save();
    console.log("[session] cookie seeded from APPSTATE variable");
  }, "env-seed");

  // ---- expiry floor: never let a loaded cookie be thrown away client-side before COOKIE_MIN_DAYS ----
  // (Facebook still decides whether the session itself is valid — this only stops the local jar from dropping it.)
  // <norm>
  const toMs = (v) => (typeof v === "number" ? (v > 1e11 ? v : v * 1000) : Date.parse(v));
  const norm = (arr, now) => {
    const floor = (now || Date.now()) + MIN_DAYS * DAY; let n = 0;
    for (const c of arr) {
      if (!c || typeof c !== "object") continue;
      const raw = c.expires != null ? c.expires : (c.expirationDate != null ? c.expirationDate : null);
      if (raw == null || raw === "Infinity" || raw === -1) continue;      // session / never-expiring: nothing to extend
      const t = toMs(raw);
      if (!Number.isFinite(t) || t >= floor) continue;                     // unparseable or already long enough: leave alone
      c.expires = new Date(floor).toUTCString();
      if (c.expirationDate != null) c.expirationDate = Math.floor(floor / 1000);
      n++;
    }
    return n;
  };
  // </norm>

  tryDo(() => {
    if (!cfg.appState) return console.log("[session] no cookie on disk — paste one in the dashboard or set APPSTATE");
    const ref = cfg.stateRefreshedAt || cfg.savedAt;
    if (ref) console.log("[session] cookie last refreshed " + Math.round((Date.now() - ref) / 36e5) + "h ago");
    const n = norm(cfg.appState);
    if (n) { S.lastStateJson = JSON.stringify(cfg.appState); console.log("[session] extended expiry on " + n + " short-lived cookie(s) to >= " + MIN_DAYS + " days"); }
  }, "boot-report");

  // ---- mirror the last known-good cookie to the volume (only while actually online) ----
  let lastMir = null;
  setInterval(() => tryDo(() => {
    if (!MIR || !S.online || !Array.isArray(cfg.appState) || !cfg.appState.length) return;
    const j = JSON.stringify(cfg.appState); if (j === lastMir) return; lastMir = j;
    writeAtomic(path.join(MIR, "appstate.json"), { at: Date.now(), state: cfg.appState });
  }, "mirror"), 60e3).unref();

  // ---- 1s watcher: login timer, early cookie capture, one fast first-retry on network blips ----
  let seenConn = S.lastConnected, fastFor = null;
  setInterval(() => tryDo(() => {
    if (S.lastConnected && S.lastConnected !== seenConn) {
      seenConn = S.lastConnected;
      if (S.loginAt && S.lastConnected >= S.loginAt) console.log("[session] login took " + ((S.lastConnected - S.loginAt) / 1000).toFixed(1) + "s");
      for (const s of [20, 90, 300]) setTimeout(() => tryDo(() => captureState("post-login +" + s + "s"), "capture"), s * 1000).unref();   // Facebook rotates tokens early; save them fast
    }
    if (!S.online && !S.logging && !S.authDead && !S.manualOff && cfg.appState && S.attempts === 1 && S.nextRetry && S.nextRetry !== fastFor
        && (!S.lastError || NET_RE.test(String(S.lastError)))) {
      const w = 700 + rnd(0, 900);
      clearTimeout(S.timer); S.nextRetry = Date.now() + w; fastFor = S.nextRetry; S.timer = setTimeout(connect, w);
      console.log("[session] network blip — fast first reconnect in " + Math.round(w) + "ms");
    }
  }, "watch"), 1000).unref();
})();

app.listen(PORT, () => { log("system", "server on " + PORT); if (cfg.appState) connect(); });
