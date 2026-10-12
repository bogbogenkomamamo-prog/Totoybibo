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

// ---------- admin password (hashed, constant-time compare) ----------
const ADMIN_FILE = path.join(DATA, "admin.json");
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString("hex") };
}
function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
let adminRec = safeRead(ADMIN_FILE);                 // { salt, hash }  (old versions stored { password })
if (adminRec.password && !adminRec.hash) { adminRec = hashPw(String(adminRec.password)); writeAtomic(ADMIN_FILE, adminRec); }
const hasAdmin = () => !!(process.env.ADMIN_PASSWORD || adminRec.hash);
function checkPw(pw) {
  pw = String(pw || "");
  if (process.env.ADMIN_PASSWORD) return safeEq(pw, process.env.ADMIN_PASSWORD);
  if (!adminRec.hash) return false;
  const h = crypto.scryptSync(pw, adminRec.salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(adminRec.hash, "hex"));
}

// ---------- config ----------
const CFG_FILE = path.join(DATA, "config.json");
const DEFAULTS = {
  appState: null, savedAt: null, stateRefreshedAt: null,
  autoReply: false, threadIds: [], running: false,
  speed: "fast", selfReact: true, selfReactRate: 0.8, markRead: true,
  skipRate: 0.2, senderCooldownS: 8, threadMax: 8, threadWindowS: 60,
  guardId: process.env.GUARD_ID || "61595490592593",
  openers: ["gm mga ka-GC 👋", "uy andito na ako", "kamusta kayo"],
};
const cfg = Object.assign({}, DEFAULTS, safeRead(CFG_FILE));
// Reply behaviour is fixed (no dashboard settings): fast human-like timing, tuned to keep the login alive.
Object.assign(cfg, { speed: "fast", selfReact: true, selfReactRate: 0.8, markRead: true, skipRate: 0.2 });
// migrate old single-GC config -> list of GCs
if (!Array.isArray(cfg.threadIds)) cfg.threadIds = [];
if (cfg.threadId) { if (!cfg.threadIds.includes(String(cfg.threadId))) cfg.threadIds.push(String(cfg.threadId)); delete cfg.threadId; }
const save = () => { try { writeAtomic(CFG_FILE, cfg); } catch (e) { console.error("[save]", e.message); } };

// ---------- reply pools (replies.json: array OR { type: [..], default: [..] }) ----------
const RAW_POOL = JSON.parse(fs.readFileSync(path.join(__dirname, "replies.json"), "utf8"));
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
  lastError: null, replies: [], daily: [], suppressed: 0,
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
  clearTimeout(S.timer); S.nextRetry = null; S.logging = true;
  let login;
  try { login = require("@dongdev/fca-unofficial"); }
  catch (e) { S.logging = false; return log("error", "fca library missing: " + e.message); }

  login({ appState: cfg.appState }, { online: true, selfListen: false, listenEvents: true, autoMarkRead: false, logLevel: "error" }, (err, api) => {
    S.logging = false;
    if (err) {
      S.lastError = String(err.message || err.error || err);
      log("error", "login: " + S.lastError);
      return isAuthError(err) ? markAuthDead(err) : scheduleRetry();
    }
    S.api = api; S.uid = String(api.getCurrentUserID()); S.online = true; S.attempts = 0; S.listenFails = 0; S.pingFails = 0;
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
    onEvent(ev).catch((err) => log("error", "event: " + (err && err.message || err)));
  });
}
function onListenError(e) {
  log("error", "listen: " + (e.message || e.error || e));
  if (isAuthError(e)) return markAuthDead(e);
  S.listenFails++;
  if (S.listenFails <= 3) {                          // try to re-listen on the SAME login first; fresh logins look suspicious
    clearTimeout(S.listenTimer);
    S.listenTimer = setTimeout(startListen, 4000 * S.listenFails + rnd(0, 2000));
    return;
  }
  drop();
}
function drop() { teardown(); S.lastDisconnected = Date.now(); scheduleRetry(); }
function scheduleRetry() {
  if (!cfg.appState || S.manualOff || S.authDead) return;
  S.attempts++;
  let s = Math.min(300, 8 * 2 ** (S.attempts - 1)) + rnd(0, 5);
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

// ---------- Bot ----------
const sendRaw = (api, text, tid, cb, replyTo) => api.sendMessage(text, tid, cb, replyTo || undefined);

function allowed(ev) {                               // anti-spam gate
  const now = Date.now();
  S.replies = S.replies.filter((t) => now - t < 3600e3);
  S.daily = S.daily.filter((t) => now - t < 86400e3);
  if (now - (S.senders.get(ev.senderID) || 0) < cfg.senderCooldownS * 1000) return false;
  const th = (S.threads.get(ev.threadID) || []).filter((t) => now - t < cfg.threadWindowS * 1000);
  S.threads.set(ev.threadID, th);
  if (S.senders.size > 2000) for (const [k, t] of S.senders) if (now - t > 3600e3) S.senders.delete(k);
  if (S.threads.size > 500) for (const [k, v] of S.threads) if (!v.length) S.threads.delete(k);
  return th.length < cfg.threadMax;
}

// True when someone replies to, or @mentions, the guarded profile.
function isGuarded(ev) {
  const id = String(cfg.guardId || "");
  if (!id || String(ev.senderID) === id) return false;
  const repliedTo = ev.messageReply && String(ev.messageReply.senderID) === id;
  const mentioned = ev.mentions && Object.prototype.hasOwnProperty.call(ev.mentions, id);
  return !!(repliedTo || mentioned);
}

async function onEvent(ev) {
  if (!ev) return;
  if ((ev.type !== "message" && ev.type !== "message_reply") || !ev.body || String(ev.senderID) === S.uid || !S.running) return;
  const target = cfg.autoReply || cfg.threadIds.includes(String(ev.threadID));
  if (!target) return;
  const guarded = isGuarded(ev);
  if (!guarded && Math.random() < cfg.skipRate) return;   // random skip (never for guard triggers)
  if (S.busy.has(ev.threadID)) return;               // don't talk over ourselves in the same chat
  if (!allowed(ev)) { S.suppressed++; return; }

  const api = S.api;
  if (!api) return;
  S.busy.add(ev.threadID);
  try {
    const social = guarded
      ? { type: "guard" }
      : chooseSocialResponse(ev.body, "", { momentum: 1, recentMessages: 1 });
    const key = poolKey(social.type);
    const r = pickBanatReply(ev.threadID, poolFor(social.type), [], "reply-pool:" + key);
    const text = typeof r === "string" && r ? r : ALL_REPLIES[Math.floor(Math.random() * ALL_REPLIES.length)];

    const now = Date.now();
    S.replies.push(now); S.daily.push(now); S.senders.set(ev.senderID, now); S.threads.get(ev.threadID).push(now);

    if (cfg.markRead && typeof api.markAsRead === "function") {   // "seen" shortly after it arrives, like a person
      setTimeout(() => { try { api.markAsRead(ev.threadID, true, () => {}); } catch {} }, rnd(250, 1200));
    }

    const ok = await sendBanatReplyWithTyping(api, text, ev.threadID, null, {
      trafficSendMessage: sendRaw,
      incomingText: ev.body,
      speed: cfg.speed,
      selfReact: cfg.selfReact ? { rate: cfg.selfReactRate } : false,   // only reacts to its OWN replies
    });
    if (ok) { rememberBanatReply(ev.threadID, text, ev.senderID); log("bot", `reply [${social.type}] -> ${ev.threadID}`); }
  } finally { S.busy.delete(ev.threadID); }
}

async function startBot() {
  if (!S.online) return log("error", "Connect first");
  S.running = true; cfg.running = true; save(); S.botSince = Date.now(); log("bot", "started");
  // one opener per selected GC, staggered so they don't all fire at the same second
  cfg.threadIds.forEach((tid, i) => {
    setTimeout(() => {
      if (!S.api || !S.running) return;
      const o = cfg.openers[Math.floor(Math.random() * cfg.openers.length)];
      sendBanatReplyWithTyping(S.api, o, tid, null, { trafficSendMessage: sendRaw, incomingText: "", speed: cfg.speed, selfReact: false });
    }, i * rnd(4000, 9000));
  });
}

// ---------- HTTP ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.get("/", (q, r) => r.sendFile(path.join(__dirname, "index.html")));   // only index.html is public
app.get("/health", (q, r) => r.json({ ok: true }));

app.post("/api/setup", (q, r) => {                   // first-run password (only works once)
  const pw = String(q.body.password || "");
  if (hasAdmin() || pw.length < 6) return r.status(400).json({ error: hasAdmin() ? "Already set" : "Min 6 characters" });
  adminRec = hashPw(pw); writeAtomic(ADMIN_FILE, adminRec); r.json({ ok: true });
});
app.get("/api/needsetup", (q, r) => r.json({ setup: !hasAdmin() }));

const fails = new Map();
app.use("/api", (req, res, next) => {
  const ip = req.ip, now = Date.now(), given = req.get("x-admin");
  const f = (fails.get(ip) || []).filter((t) => now - t < 900e3);
  if (f.length >= 10) return res.status(429).json({ error: "Too many wrong tries. Wait 15 min." });
  if (hasAdmin() && given !== undefined && checkPw(given)) { fails.delete(ip); return next(); }
  if (given !== undefined) { f.push(now); fails.set(ip, f); }
  if (fails.size > 500) for (const [k, v] of fails) if (!v.some((t) => now - t < 900e3)) fails.delete(k);
  res.status(401).json({ error: "unauthorized" });
});

const status = () => ({
  online: S.online, running: S.running, uid: S.uid, authDead: S.authDead,
  serverUptime: (Date.now() - S.started) / 1000 | 0, botUptime: S.running && S.botSince ? (Date.now() - S.botSince) / 1000 | 0 : 0,
  lastConnected: S.lastConnected, lastDisconnected: S.lastDisconnected, lastPing: S.lastPing, lastEventAt: S.lastEventAt,
  stateRefreshedAt: cfg.stateRefreshedAt, savedAt: cfg.savedAt,
  autoReply: cfg.autoReply, threadIds: cfg.threadIds, repliesHour: S.replies.length, repliesDay: S.daily.length, suppressed: S.suppressed,
  attempts: S.attempts, nextRetry: S.nextRetry, lastError: S.lastError, cookieSaved: !!cfg.appState,
  log: S.log.slice(0, 40),
});
app.get("/api/status", (q, r) => r.json(status()));
app.post("/api/auto", (q, r) => { cfg.autoReply = !!q.body.on; save(); r.json(status()); });
app.post("/api/thread", (q, r) => {                   // toggle one GC on/off: { threadId, on }
  const id = String(q.body.threadId || "");
  if (!id) return r.status(400).json({ error: "threadId required" });
  const has = cfg.threadIds.includes(id);
  if (q.body.on && !has) cfg.threadIds.push(id);
  if (!q.body.on && has) cfg.threadIds = cfg.threadIds.filter((t) => t !== id);
  save(); r.json(status());
});
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
    S.manualOff = false; S.authDead = false; S.attempts = 0; S.lastError = null;
    if (S.online) teardown();
    connect(); r.json(status());
  } catch (e) { r.status(400).json({ error: "Invalid cookie (need a JSON array or c_user=...; xs=...)" }); }
});
app.get("/api/threads", (q, r) => {
  if (!S.api) return r.json([]);
  S.api.getThreadList(50, null, ["INBOX"], (e, l) => r.json(e ? [] : l.filter((t) => t.isGroup).map((t) => ({ id: t.threadID, name: t.name || t.threadID }))));
});

// A month-long process must not die on one stray exception, and must save the
// freshest cookie when the host (Railway) sends SIGTERM on redeploy.
process.on("uncaughtException", (e) => log("fatal", (e && e.stack) || e));
process.on("unhandledRejection", (e) => log("fatal", (e && e.stack) || e));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { captureState("shutdown"); save(); process.exit(0); });

app.listen(PORT, () => { log("system", "server on " + PORT); if (cfg.appState) connect(); });
