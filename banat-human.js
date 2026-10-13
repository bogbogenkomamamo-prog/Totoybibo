"use strict";

const { BANAT_SHORTHANDS } = require("./banat-abbreviations");
const { chooseSocialResponse, socialTimingMultiplier } = require("./banat-social");
const { humanize } = require("./human-mimic");
const { calculateHumanDelay } = require("./human-delay");
const { startTyping, stopTyping } = require("./human-typing");

const REPLY_DELAY_MS = Math.max(0, Number(process.env.BANAT_REPLY_DELAY_MS || 900));
const MAX_DELAY_MS = Math.max(2500, Number(process.env.BANAT_MAX_HUMAN_DELAY_MS || 6500));

// Speed presets. "fast" keeps the full human feel (typing indicator, small
// jitter, occasional hesitation) but compresses the waits so replies land in
// roughly 1-3 seconds instead of 3-8.
const SPEED = {
  fast:   { reaction: 0.45, typing: 0.5, maxReaction: 900,  maxTyping: 2800, minReaction: 100, minTyping: 300 },
  normal: { reaction: 1,    typing: 1,   maxReaction: 1800, maxTyping: MAX_DELAY_MS, minReaction: 120, minTyping: 350 },
  slow:   { reaction: 1.4,  typing: 1.3, maxReaction: 2600, maxTyping: MAX_DELAY_MS, minReaction: 120, minTyping: 350 },
};

const DEFAULT_SELF_REACTIONS = ["😆", "😂", "🤣", "💀", "😭"];
const DEFAULT_INCOMING_REACTIONS = ["😆", "😂", "👍", "❤️"];

const state = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function speedProfile(name) {
  return SPEED[name] || SPEED.fast;
}

function pruneState(now) {
  if (state.size < 500) return;
  for (const [key, value] of state) {
    if (now - value.at > 10 * 60 * 1000) state.delete(key);
  }
}

function createHumanContext(threadID, incomingText = "") {
  const key = String(threadID || "unknown");
  const now = Date.now();
  const prev = state.get(key);
  const within = prev && now - prev.at < 45_000;
  const recentMessages = within ? Math.min(8, Number(prev.count || 0) + 1) : 1;
  const incomingWords = String(incomingText).trim().split(/\s+/).filter(Boolean).length;
  const mode = recentMessages >= 5 ? "rushed" : recentMessages >= 3 ? "normal" : "chill";
  const momentum = Math.max(1, recentMessages + (incomingWords >= 18 ? 1 : 0) + (incomingWords >= 35 ? 1 : 0));

  state.set(key, { at: now, count: recentMessages });
  pruneState(now);

  return {
    threadID: key,
    incomingText: String(incomingText),
    incomingWords,
    incomingChars: String(incomingText).length,
    recentMessages,
    momentum,
    mode,
    elapsedSincePreviousMs: within ? now - prev.at : null,
  };
}

function prepareBanatReply(threadID, message, incomingText = "", options = {}) {
  const speed = speedProfile(options.speed);
  const context = createHumanContext(threadID, incomingText);

  const text = humanize(message, {
    abbreviations: BANAT_SHORTHANDS,
    abbreviationRate: Number(process.env.BANAT_SHORTHAND_RATE || 0.035),
    typoRate: Number(process.env.BANAT_TYPO_RATE || 0.085),
    caseVariationRate: Number(process.env.BANAT_CASE_VARIATION_RATE || 0.035),
    spaceVariationRate: Number(process.env.BANAT_SPACE_SLIP_RATE || 0.018),
    abbreviate: true,
    typos: !/sinzu/i.test(message),   // keep the signed guard reply clean
    punctuation: true,
  });

  const social = chooseSocialResponse(incomingText, text, context);
  const timing = calculateHumanDelay(
    text,
    { ...context, social },
    {
      max: speed.maxReaction,
      maxTypingMs: speed.maxTyping,
      hesitationRate: Number(process.env.BANAT_HESITATION_RATE || 0.11),
    }
  );
  const multiplier = socialTimingMultiplier(social);

  return {
    text,
    context: { ...context, social },
    social,
    reactionMs: clamp(
      (Number(timing.reactionMs) || REPLY_DELAY_MS) * multiplier * speed.reaction,
      speed.minReaction,
      speed.maxReaction
    ),
    typingMs: clamp(
      (Number(timing.typingMs) || speed.minTyping) * multiplier * speed.typing,
      speed.minTyping,
      speed.maxTyping
    ),
  };
}

function react(api, emoji, messageID, threadID) {
  if (!api || !emoji || !messageID || !threadID) return;
  const noop = () => {};
  try {
    // fca signature: (reaction, messageID, threadID, callback). threadID MUST be the 3rd arg,
    // otherwise the library rejects with "Missing required parameters".
    let result;
    if (typeof api.setMessageReactionMqtt === "function") {
      result = api.setMessageReactionMqtt(emoji, String(messageID), String(threadID), noop);
    } else if (typeof api.setMessageReaction === "function") {
      result = api.setMessageReaction(emoji, String(messageID), String(threadID), noop, true);
    }
    // The library may reject asynchronously; swallow it so it never reaches unhandledRejection.
    if (result && typeof result.catch === "function") result.catch(noop);
  } catch (_) {
    /* reactions are cosmetic; never let them break a reply */
  }
}

// Schedules one reaction after a human-looking pause. `conf.rate` is the
// chance (0..1) that a reaction happens at all.
function scheduleReaction(api, conf, defaults, messageID, threadID, minMs, maxMs) {
  if (!conf || !messageID) return;
  const rate = clamp(Number(conf.rate ?? 1), 0, 1);
  if (Math.random() >= rate) return;

  const emojis = Array.isArray(conf.emojis) && conf.emojis.length ? conf.emojis : defaults;
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  const wait = minMs + Math.random() * Math.max(0, maxMs - minMs);

  const timer = setTimeout(() => react(api, emoji, messageID, threadID), wait);
  if (timer.unref) timer.unref();
}

/**
 * dependencies:
 *   trafficSendMessage(api, text, threadID, cb, replyToMessageID)  required
 *   incomingText      text being replied to (drives timing / social mode)
 *   speed             "fast" | "normal" | "slow"   (default "fast")
 *   selfReact         false to disable, or { rate, emojis } (default: always, mixed laugh emojis)
 *   incomingReact     { rate, emojis, messageID } to react to the message being answered
 *   replyDelayMs      force the pre-typing delay
 */
function sendBanatReplyWithTyping(api, message, threadID, replyToMessageID = null, dependencies = {}) {
  const send = dependencies.trafficSendMessage;
  if (typeof send !== "function") return Promise.resolve(false);

  const prepared = prepareBanatReply(threadID, message, dependencies.incomingText || "", {
    speed: dependencies.speed,
  });
  const delay = Math.max(100, Number(dependencies.replyDelayMs || prepared.reactionMs));

  const selfReact =
    dependencies.selfReact === false ? null : dependencies.selfReact || { rate: 1 };
  const incomingReact = dependencies.incomingReact || null;

  // React to the incoming message while "reading" it, before typing starts.
  if (incomingReact && incomingReact.messageID) {
    scheduleReaction(
      api,
      incomingReact,
      DEFAULT_INCOMING_REACTIONS,
      incomingReact.messageID,
      threadID,
      120,
      Math.max(200, Math.min(900, delay))
    );
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      startTyping(api, threadID);

      setTimeout(() => {
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          stopTyping(api, threadID);
          resolve(ok);
        };

        try {
          send(
            api,
            prepared.text,
            threadID,
            (err, info) => {
              if (err) {
                console.error("[BANAT] send failed:", err?.message || err);
                finish(false);
                return;
              }

              const id = typeof info === "string" ? info : info?.messageID || info?.messageId || info?.id;
              // Self react: react to our own just-sent message, a beat later.
              scheduleReaction(api, selfReact, DEFAULT_SELF_REACTIONS, id, threadID, 500, 2200);
              finish(true);
            },
            replyToMessageID || null
          );
        } catch (e) {
          console.error("[BANAT] reply error:", e);
          finish(false);
        }
      }, prepared.typingMs);
    }, delay);
  });
}

module.exports = {
  BANAT_REPLY_DELAY_MS: REPLY_DELAY_MS,
  BANAT_MAX_HUMAN_DELAY_MS: MAX_DELAY_MS,
  SPEED_PRESETS: Object.keys(SPEED),
  prepareBanatReply,
  sendBanatReplyWithTyping,
};
