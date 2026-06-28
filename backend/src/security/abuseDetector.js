/**
 * Abuse / anomaly detection for vote traffic.
 * -------------------------------------------
 * Threat model (see SECURITY_DEFENSE.md):
 *   A live poll is trivially gameable. The existing defences are:
 *     1. a unique index on (session, pollIndex, voterKey) -> one vote per voter, and
 *     2. a per-socket throttle of 5 votes/sec in pollSocket.js.
 *   Both are weak on their own:
 *     - (1) is bypassed by minting a NEW voterKey (clear localStorage / incognito / script).
 *     - (2) is bypassed by reconnecting: a new socket gets a fresh throttle window.
 *   This module adds state that SURVIVES reconnects and identity rotation, keyed on the
 *   device fingerprint and the client IP, and auto-blocks offenders for a cooldown.
 *
 * The frontend voterKey has the shape `${fingerprintjs_visitorId}_${localStorage_nonce}`
 * (frontend/src/app/features/audience/answer/answer.component.ts:145). The visitorId is a
 * DEVICE property; the nonce is a BROWSER-STORAGE property. So:
 *
 *   one fingerprint + many voterKeys  ==  one device deliberately re-minting identities
 *                                         to defeat the unique index. That is the core
 *                                         vote-flooding signature we detect.
 *
 * Detection rules (all sliding-window, all explainable -- deliberately NOT ML):
 *
 *   FP_VOTE_RATE        block  > maxVotesPerFingerprint votes / voteWindowMs from one fingerprint.
 *                              A human taps one answer per poll. A script does 50 in 2s.
 *   FP_IDENTITY_CHURN   block  > maxKeysPerFingerprint distinct voterKeys / clusterWindowMs from
 *                              one fingerprint. This is the "fingerprint clustering" signal: we
 *                              group sessions by device and flag devices whose identity
 *                              cardinality is impossible for a human (clearing storage once is
 *                              normal; doing it four times in a minute is not).
 *   IP_VOTE_RATE        block  > maxVotesPerIp votes / voteWindowMs from one IP. Sized so that
 *                              only a machine can reach it (see NAT note below).
 *   IP_FP_CARDINALITY   FLAG   > maxFingerprintsPerIp distinct fingerprints / clusterWindowMs
 *                              from one IP. Bot-farm / fingerprint-rotation signature.
 *
 * *** WHY IP_FP_CARDINALITY ONLY FLAGS AND DOES NOT BLOCK BY DEFAULT ***
 * This app's happy path is a lecture hall: 200 students on ONE campus NAT, each with a distinct
 * device fingerprint, all voting within seconds. That is indistinguishable from a bot farm by
 * cardinality alone. Auto-blocking on it would ban the entire audience -- the worst possible
 * false positive. So the IP-cardinality rule raises an alert to the presenter and logs, but does
 * not block unless an operator opts in (ABUSE_BLOCK_ON_IP_CLUSTER=true) for a deployment where
 * shared NAT is not expected. The rules that DO auto-block are all per-device, where a single
 * physical human cannot plausibly produce the traffic. This asymmetry is the whole design.
 *
 * *** SINGLE-NODE / IN-MEMORY ***
 * All state is in-memory Maps, which is correct for the current single-node deployment (one Koyeb
 * container, sticky Socket.IO). It breaks with >1 replica: each node would see only its share of
 * the traffic, so an attacker spread across nodes gets N x the budget, and a block on node A is
 * not honoured by node B. To scale out, move the three primitives to Redis, keeping the same
 * rules:
 *   - sliding-window counters -> per-key Redis sorted set (ZADD ts, ZREMRANGEBYSCORE to prune,
 *     ZCARD to count) or the simpler INCR + EXPIRE fixed-window if approximation is acceptable;
 *   - cardinality sets (fp->voterKeys, ip->fps) -> Redis SET with TTL, or HyperLogLog (PFADD /
 *     PFCOUNT) if approximate counts are fine and memory matters;
 *   - the blocklist -> plain Redis key with TTL, which gives cooldown expiry for free and is
 *     read by every node.
 * Evaluation stays identical; only the storage layer changes. That is why the rules below are
 * written against a small internal store interface rather than reaching into Maps directly.
 */

// ---------------------------------------------------------------------------
// Sliding-window counter: timestamps in a window, pruned lazily on read/write.
// ---------------------------------------------------------------------------
class SlidingWindow {
  constructor() { this.events = new Map(); } // key -> number[] (sorted ascending)

  /** Record an event and return the number of events in the trailing window. */
  hit(key, now, windowMs) {
    const arr = this.events.get(key) || [];
    prune(arr, now - windowMs);
    arr.push(now);
    this.events.set(key, arr);
    return arr.length;
  }

  count(key, now, windowMs) {
    const arr = this.events.get(key);
    if (!arr) return 0;
    prune(arr, now - windowMs);
    return arr.length;
  }

  sweep(now, windowMs) {
    for (const [key, arr] of this.events) {
      prune(arr, now - windowMs);
      if (arr.length === 0) this.events.delete(key);
    }
  }
}

/** Drop leading timestamps older than `cutoff`. Array stays sorted, so a shift-loop is O(dropped). */
function prune(arr, cutoff) {
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

// ---------------------------------------------------------------------------
// Cardinality set: key -> Map<member, lastSeenTs>. Cardinality = live members
// in the trailing window. This is the "clustering" primitive: group by a key,
// count distinct members, flag oversized groups.
// ---------------------------------------------------------------------------
class CardinalitySet {
  constructor() { this.groups = new Map(); }

  /** Add member to key's group and return the group's live cardinality. */
  add(key, member, now, windowMs) {
    const g = this.groups.get(key) || new Map();
    g.set(member, now);
    pruneGroup(g, now - windowMs);
    this.groups.set(key, g);
    return g.size;
  }

  size(key, now, windowMs) {
    const g = this.groups.get(key);
    if (!g) return 0;
    pruneGroup(g, now - windowMs);
    return g.size;
  }

  members(key, now, windowMs) {
    const g = this.groups.get(key);
    if (!g) return [];
    pruneGroup(g, now - windowMs);
    return [...g.keys()];
  }

  sweep(now, windowMs) {
    for (const [key, g] of this.groups) {
      pruneGroup(g, now - windowMs);
      if (g.size === 0) this.groups.delete(key);
    }
  }
}

function pruneGroup(group, cutoff) {
  for (const [member, ts] of group) {
    if (ts <= cutoff) group.delete(member);
  }
}

// ---------------------------------------------------------------------------

const DEFAULTS = {
  enabled: true,
  // Vote-rate spike detection
  voteWindowMs: 10_000,
  maxVotesPerFingerprint: 8, // a human answers ~1 poll/10s; 8 is generous headroom
  maxVotesPerIp: 300,        // ~30 votes/sec from one egress IP -- see NAT note above
  // Clustering / cardinality detection
  clusterWindowMs: 60_000,
  maxKeysPerFingerprint: 3,  // clearing storage once is plausible; 4+ identities/min is not
  maxFingerprintsPerIp: 25,  // FLAG only by default (shared NAT is legitimate here)
  blockOnIpCluster: false,
  // Enforcement
  blockMs: 60_000,
  sweepEvery: 500            // run a memory sweep every N checks (no timers -> no open handles)
};

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function configFromEnv() {
  return {
    enabled: process.env.ABUSE_DETECTION_ENABLED !== 'false',
    voteWindowMs: envNum('ABUSE_VOTE_WINDOW_MS', DEFAULTS.voteWindowMs),
    maxVotesPerFingerprint: envNum('ABUSE_MAX_VOTES_PER_FP', DEFAULTS.maxVotesPerFingerprint),
    maxVotesPerIp: envNum('ABUSE_MAX_VOTES_PER_IP', DEFAULTS.maxVotesPerIp),
    clusterWindowMs: envNum('ABUSE_CLUSTER_WINDOW_MS', DEFAULTS.clusterWindowMs),
    maxKeysPerFingerprint: envNum('ABUSE_MAX_KEYS_PER_FP', DEFAULTS.maxKeysPerFingerprint),
    maxFingerprintsPerIp: envNum('ABUSE_MAX_FPS_PER_IP', DEFAULTS.maxFingerprintsPerIp),
    blockOnIpCluster: process.env.ABUSE_BLOCK_ON_IP_CLUSTER === 'true',
    blockMs: envNum('ABUSE_BLOCK_MS', DEFAULTS.blockMs),
    sweepEvery: DEFAULTS.sweepEvery
  };
}

/**
 * Extract the device fingerprint from a voterKey.
 * voterKey is `${visitorId}_${localSessionNonce}` -- the visitorId is the stable device id.
 * Falls back to the whole key when the shape does not match (older clients / FingerprintJS
 * failure path, which emits `v_<random>` and has no device component at all).
 */
function deriveFingerprint(voterKey) {
  if (typeof voterKey !== 'string' || !voterKey) return null;
  const i = voterKey.indexOf('_');
  if (i <= 0) return voterKey;
  const prefix = voterKey.slice(0, i);
  // The FingerprintJS fallback path produces keys literally prefixed with "v_", which is a
  // per-browser random, NOT a device id. Treat the whole key as the fingerprint there so we
  // never cluster unrelated users under a shared "v" bucket.
  if (prefix === 'v') return voterKey;
  return prefix;
}

/** Best-effort client IP for a Socket.IO connection (trust_proxy=1 => first XFF hop). */
function clientIpFromSocket(socket) {
  const xff = socket?.handshake?.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return socket?.handshake?.address || 'unknown';
}

class AbuseDetector {
  constructor(opts = {}) {
    this.config = { ...DEFAULTS, ...configFromEnv(), ...opts };
    this.now = opts.now || Date.now;
    this.onEvent = opts.onEvent || null; // (event) => void, for logging/alerting

    this.votesByFp = new SlidingWindow();   // "fp:<session>:<fingerprint>" -> vote timestamps
    this.votesByIp = new SlidingWindow();   // "ip:<session>:<ip>"          -> vote timestamps
    this.keysByFp = new CardinalitySet();   // fingerprint -> distinct voterKeys
    this.fpsByIp = new CardinalitySet();    // ip          -> distinct fingerprints
    this.blocks = new Map();                // "<kind>:<value>" -> { until, rule, sessionId }
    this.checks = 0;
    this.flags = [];                        // recent non-blocking flags (bounded)
  }

  _blockKey(kind, value) { return `${kind}:${value}`; }

  isBlocked(kind, value, now = this.now()) {
    const k = this._blockKey(kind, value);
    const b = this.blocks.get(k);
    if (!b) return null;
    if (b.until <= now) { this.blocks.delete(k); return null; }
    return b;
  }

  block(kind, value, rule, sessionId, now = this.now()) {
    const until = now + this.config.blockMs;
    this.blocks.set(this._blockKey(kind, value), { until, rule, sessionId, kind, value });
    return until;
  }

  _emit(event) {
    if (this.onEvent) {
      try { this.onEvent(event); } catch { /* never let logging break voting */ }
    }
    return event;
  }

  _flag(event) {
    this.flags.push(event);
    if (this.flags.length > 100) this.flags.shift();
    return this._emit(event);
  }

  /**
   * Evaluate a single vote attempt. Records the event AND returns the verdict.
   * Returns { allowed: true, flags: [] } or
   *         { allowed: false, rule, reason, retryAfterMs, ... }.
   */
  check({ sessionId, voterKey, fingerprint, ip }) {
    if (!this.config.enabled) return { allowed: true, flags: [] };

    const now = this.now();
    const cfg = this.config;

    if (++this.checks % cfg.sweepEvery === 0) this.sweep(now);

    const fp = fingerprint || deriveFingerprint(voterKey) || 'unknown';
    const addr = ip || 'unknown';
    const sid = sessionId || 'global';

    // 1) Already blocked? Reject before doing any accounting, so a blocked flooder's
    //    continued hammering does not inflate the windows (and cannot extend its own ban).
    const fpBlock = this.isBlocked('fp', fp, now);
    if (fpBlock) {
      return {
        allowed: false, rule: fpBlock.rule, scope: 'fingerprint',
        reason: 'Blocked: automated voting detected',
        retryAfterMs: fpBlock.until - now
      };
    }
    const ipBlock = this.isBlocked('ip', addr, now);
    if (ipBlock) {
      return {
        allowed: false, rule: ipBlock.rule, scope: 'ip',
        reason: 'Blocked: automated voting detected',
        retryAfterMs: ipBlock.until - now
      };
    }

    // 2) Record this attempt in every window/cluster it belongs to.
    const fpVotes = this.votesByFp.hit(`${sid}:${fp}`, now, cfg.voteWindowMs);
    const ipVotes = this.votesByIp.hit(`${sid}:${addr}`, now, cfg.voteWindowMs);
    const keysForFp = voterKey
      ? this.keysByFp.add(fp, voterKey, now, cfg.clusterWindowMs)
      : this.keysByFp.size(fp, now, cfg.clusterWindowMs);
    const fpsForIp = this.fpsByIp.add(addr, fp, now, cfg.clusterWindowMs);

    const flags = [];

    // 3) Blocking rules -- all per-device, where one human cannot plausibly produce the traffic.

    // RULE FP_VOTE_RATE: vote-rate spike from a single device.
    if (fpVotes > cfg.maxVotesPerFingerprint) {
      const until = this.block('fp', fp, 'FP_VOTE_RATE', sid, now);
      return this._emit({
        type: 'abuse:block', allowed: false, rule: 'FP_VOTE_RATE', scope: 'fingerprint',
        sessionId: sid, fingerprint: fp, ip: addr,
        observed: fpVotes, threshold: cfg.maxVotesPerFingerprint, windowMs: cfg.voteWindowMs,
        reason: 'Blocked: automated voting detected',
        retryAfterMs: until - now, at: now
      });
    }

    // RULE FP_IDENTITY_CHURN: one device minting many voterKeys == evading the unique index.
    if (keysForFp > cfg.maxKeysPerFingerprint) {
      const until = this.block('fp', fp, 'FP_IDENTITY_CHURN', sid, now);
      return this._emit({
        type: 'abuse:block', allowed: false, rule: 'FP_IDENTITY_CHURN', scope: 'fingerprint',
        sessionId: sid, fingerprint: fp, ip: addr,
        observed: keysForFp, threshold: cfg.maxKeysPerFingerprint, windowMs: cfg.clusterWindowMs,
        reason: 'Blocked: automated voting detected',
        retryAfterMs: until - now, at: now
      });
    }

    // RULE IP_VOTE_RATE: volumetric flood from one egress IP. Threshold is deliberately high
    // so a large room on shared NAT stays under it; only a machine sustains this.
    if (ipVotes > cfg.maxVotesPerIp) {
      const until = this.block('ip', addr, 'IP_VOTE_RATE', sid, now);
      return this._emit({
        type: 'abuse:block', allowed: false, rule: 'IP_VOTE_RATE', scope: 'ip',
        sessionId: sid, fingerprint: fp, ip: addr,
        observed: ipVotes, threshold: cfg.maxVotesPerIp, windowMs: cfg.voteWindowMs,
        reason: 'Blocked: automated voting detected',
        retryAfterMs: until - now, at: now
      });
    }

    // 4) RULE IP_FP_CARDINALITY: many distinct devices behind one IP. This is a LEAD, not a
    //    verdict -- a lecture hall on campus wifi looks exactly like this. Flag + alert the
    //    presenter; only block if an operator explicitly opted in for their environment.
    if (fpsForIp > cfg.maxFingerprintsPerIp) {
      const event = {
        type: cfg.blockOnIpCluster ? 'abuse:block' : 'abuse:flag',
        rule: 'IP_FP_CARDINALITY', scope: 'ip',
        sessionId: sid, fingerprint: fp, ip: addr,
        observed: fpsForIp, threshold: cfg.maxFingerprintsPerIp, windowMs: cfg.clusterWindowMs,
        note: 'Many distinct device fingerprints from one IP. Expected on shared NAT; ' +
              'suspicious only if paired with high per-device vote rates.',
        at: now
      };
      if (cfg.blockOnIpCluster) {
        const until = this.block('ip', addr, 'IP_FP_CARDINALITY', sid, now);
        return this._emit({
          ...event, allowed: false,
          reason: 'Blocked: automated voting detected',
          retryAfterMs: until - now
        });
      }
      this._flag(event);
      flags.push(event);
    }

    return { allowed: true, flags, fingerprint: fp, ip: addr };
  }

  /** Drop expired state so memory stays bounded across long-running sessions. */
  sweep(now = this.now()) {
    const cfg = this.config;
    this.votesByFp.sweep(now, cfg.voteWindowMs);
    this.votesByIp.sweep(now, cfg.voteWindowMs);
    this.keysByFp.sweep(now, cfg.clusterWindowMs);
    this.fpsByIp.sweep(now, cfg.clusterWindowMs);
    for (const [k, b] of this.blocks) {
      if (b.until <= now) this.blocks.delete(k);
    }
  }

  /** Introspection for the presenter dashboard / debugging. */
  stats(now = this.now()) {
    this.sweep(now);
    return {
      activeBlocks: [...this.blocks.values()].map(b => ({
        kind: b.kind, value: b.value, rule: b.rule, expiresInMs: b.until - now
      })),
      trackedFingerprints: this.votesByFp.events.size,
      trackedIps: this.votesByIp.events.size,
      recentFlags: this.flags.slice(-10),
      config: this.config
    };
  }

  reset() {
    this.votesByFp = new SlidingWindow();
    this.votesByIp = new SlidingWindow();
    this.keysByFp = new CardinalitySet();
    this.fpsByIp = new CardinalitySet();
    this.blocks.clear();
    this.flags = [];
    this.checks = 0;
  }
}

// Shared singleton used by the socket layer. Tests build their own instance with a fake clock.
const detector = new AbuseDetector({
  onEvent: (e) => {
    const level = e.type === 'abuse:block' ? 'BLOCK' : 'FLAG';
    console.warn(
      `[abuse:${level}] rule=${e.rule} scope=${e.scope} session=${e.sessionId} ` +
      `fp=${String(e.fingerprint).slice(0, 12)} ip=${e.ip} observed=${e.observed}/${e.threshold}`
    );
  }
});

module.exports = {
  AbuseDetector,
  detector,
  deriveFingerprint,
  clientIpFromSocket,
  DEFAULTS
};
