const test = require('node:test');
const assert = require('node:assert');
const { AbuseDetector, deriveFingerprint, clientIpFromSocket } = require('../src/security/abuseDetector');

/**
 * Deterministic tests: we inject a fake clock instead of sleeping, so the sliding windows and
 * block cooldowns can be exercised exactly without making the suite slow or flaky.
 */
function makeDetector(overrides = {}) {
  const clock = { t: 1_000_000 };
  const detector = new AbuseDetector({
    now: () => clock.t,
    // pin config so env vars on a dev machine cannot change test outcomes
    enabled: true,
    voteWindowMs: 10_000,
    maxVotesPerFingerprint: 8,
    maxVotesPerIp: 300,
    clusterWindowMs: 60_000,
    maxKeysPerFingerprint: 3,
    maxFingerprintsPerIp: 25,
    blockOnIpCluster: false,
    blockMs: 60_000,
    ...overrides
  });
  return { detector, clock };
}

const vote = (d, o) => d.check({ sessionId: 's1', ...o });

// ---------------------------------------------------------------------------
// Fingerprint derivation
// ---------------------------------------------------------------------------

test('deriveFingerprint extracts the device id from `visitorId_localSession`', () => {
  assert.strictEqual(deriveFingerprint('abc123device_xyzlocal'), 'abc123device');
});

test('deriveFingerprint does NOT cluster the FingerprintJS-failure fallback keys together', () => {
  // Fallback keys look like `v_<random>`. If we naively split on "_", every user whose
  // FingerprintJS load failed would share the fingerprint "v" and get mass-blocked as one device.
  const a = deriveFingerprint('v_abc123');
  const b = deriveFingerprint('v_def456');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, 'v_abc123');
});

// ---------------------------------------------------------------------------
// Rule 1: vote-rate spike (bot hammering the vote button)
// ---------------------------------------------------------------------------

test('vote-flood from one fingerprint trips FP_VOTE_RATE and auto-blocks', () => {
  const { detector } = makeDetector();
  const bot = { voterKey: 'botdev_s1', fingerprint: 'botdev', ip: '10.0.0.9' };

  // 8 votes are within budget (maxVotesPerFingerprint = 8)
  for (let i = 0; i < 8; i++) {
    assert.strictEqual(vote(detector, bot).allowed, true, `vote ${i + 1} should be allowed`);
  }

  // the 9th crosses the threshold -> blocked
  const v = vote(detector, bot);
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.rule, 'FP_VOTE_RATE');
  assert.strictEqual(v.scope, 'fingerprint');
  assert.ok(v.retryAfterMs > 0);
});

test('a blocked flooder stays blocked for the cooldown, then is released', () => {
  const { detector, clock } = makeDetector();
  const bot = { voterKey: 'botdev_s1', fingerprint: 'botdev', ip: '10.0.0.9' };

  for (let i = 0; i < 9; i++) vote(detector, bot);
  assert.strictEqual(vote(detector, bot).allowed, false, 'still inside cooldown');

  // halfway through the cooldown -> still blocked
  clock.t += 30_000;
  assert.strictEqual(vote(detector, bot).allowed, false);

  // past the cooldown -> released (block is a cooldown, not a permaban)
  clock.t += 61_000;
  assert.strictEqual(vote(detector, bot).allowed, true, 'block should expire');
});

test('vote-rate window slides: a slow steady voter is never blocked', () => {
  const { detector, clock } = makeDetector();
  const human = { voterKey: 'humandev_s1', fingerprint: 'humandev', ip: '10.0.0.1' };

  // 40 votes, one every 5s -- more polls than any real talk, but never 8-in-10s, so the sliding
  // window drains faster than it fills and the total count never matters.
  for (let i = 0; i < 40; i++) {
    const v = vote(detector, human);
    assert.strictEqual(v.allowed, true, `steady vote ${i + 1} must be allowed`);
    clock.t += 5_000;
  }
});

// ---------------------------------------------------------------------------
// Rule 2: fingerprint clustering / identity churn (the vote-flooding signature)
// ---------------------------------------------------------------------------

test('one device minting many voterKeys trips FP_IDENTITY_CHURN (unique-index evasion)', () => {
  const { detector } = makeDetector();
  // Attacker clears localStorage between votes to defeat the (session,pollIndex,voterKey) unique
  // index. Each vote carries a NEW voterKey -- but the device half of the key never changes.
  const fp = 'attackerdevice';

  assert.strictEqual(vote(detector, { voterKey: `${fp}_id1`, fingerprint: fp, ip: '1.2.3.4' }).allowed, true);
  assert.strictEqual(vote(detector, { voterKey: `${fp}_id2`, fingerprint: fp, ip: '1.2.3.4' }).allowed, true);
  assert.strictEqual(vote(detector, { voterKey: `${fp}_id3`, fingerprint: fp, ip: '1.2.3.4' }).allowed, true);

  // 4th distinct identity from the same physical device in a minute -> not a human
  const v = vote(detector, { voterKey: `${fp}_id4`, fingerprint: fp, ip: '1.2.3.4' });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.rule, 'FP_IDENTITY_CHURN');
  assert.strictEqual(v.observed, 4);
  assert.strictEqual(v.threshold, 3);
});

test('identity churn is caught even when the client omits/forges the fingerprint field', () => {
  const { detector } = makeDetector();
  // The client controls `fingerprint`, so a smart attacker just stops sending it. The backend
  // derives the device id from voterKey instead -- which the attacker MUST send to vote at all.
  const fp = 'sneakydevice';
  for (let i = 1; i <= 3; i++) {
    assert.strictEqual(
      detector.check({ sessionId: 's1', voterKey: `${fp}_id${i}`, ip: '1.2.3.4' }).allowed,
      true
    );
  }
  const v = detector.check({ sessionId: 's1', voterKey: `${fp}_id4`, ip: '1.2.3.4' });
  assert.strictEqual(v.allowed, false, 'derivation from voterKey must still catch this');
  assert.strictEqual(v.rule, 'FP_IDENTITY_CHURN');
});

test('clearing storage ONCE is not enough to get blocked (tolerates honest churn)', () => {
  const { detector } = makeDetector();
  const fp = 'honestdevice';
  // A real user who clears site data / switches to incognito once produces 2 identities.
  assert.strictEqual(vote(detector, { voterKey: `${fp}_a`, fingerprint: fp, ip: '9.9.9.9' }).allowed, true);
  assert.strictEqual(vote(detector, { voterKey: `${fp}_b`, fingerprint: fp, ip: '9.9.9.9' }).allowed, true);
  assert.strictEqual(vote(detector, { voterKey: `${fp}_c`, fingerprint: fp, ip: '9.9.9.9' }).allowed, true);
});

test('identity-churn window slides: identities spread over hours do not accumulate', () => {
  const { detector, clock } = makeDetector();
  const fp = 'longsessiondevice';
  for (let i = 0; i < 10; i++) {
    const v = vote(detector, { voterKey: `${fp}_id${i}`, fingerprint: fp, ip: '9.9.9.9' });
    assert.strictEqual(v.allowed, true, `identity ${i} beyond the cluster window must not stack`);
    clock.t += 61_000; // each new identity appears after the 60s cluster window has rolled over
  }
});

// ---------------------------------------------------------------------------
// Rule 3 + 4: IP-scoped rules and the shared-NAT false-positive problem
// ---------------------------------------------------------------------------

test('volumetric flood from one IP across rotating fingerprints trips IP_VOTE_RATE', () => {
  // Attacker rotates the fingerprint every vote (spoofing the device id), so no single
  // fingerprint ever trips FP_VOTE_RATE. The per-IP volumetric rule is the backstop.
  const { detector } = makeDetector({ maxVotesPerIp: 50, maxFingerprintsPerIp: 10_000 });

  let blocked = null;
  for (let i = 0; i < 60 && !blocked; i++) {
    const v = detector.check({
      sessionId: 's1',
      voterKey: `spoofed${i}_id${i}`,
      fingerprint: `spoofed${i}`,
      ip: '5.5.5.5'
    });
    if (!v.allowed) blocked = v;
  }
  assert.ok(blocked, 'rotating fingerprints from one IP must still be caught by volume');
  assert.strictEqual(blocked.rule, 'IP_VOTE_RATE');
  assert.strictEqual(blocked.scope, 'ip');
});

test('FALSE POSITIVE GUARD: a lecture hall behind one NAT is FLAGGED, never blocked', () => {
  // 200 students, one campus IP, one vote each, all within a few seconds. By cardinality alone
  // this is indistinguishable from a bot farm -- blocking it would ban the entire audience.
  // The IP_FP_CARDINALITY rule must therefore FLAG (alert the presenter) and let the votes through.
  const { detector, clock } = makeDetector();

  let flagged = 0;
  for (let i = 0; i < 200; i++) {
    const v = detector.check({
      sessionId: 's1',
      voterKey: `student${i}_local${i}`,
      fingerprint: `student${i}`,
      ip: '203.0.113.7' // one shared campus NAT
    });
    assert.strictEqual(v.allowed, true, `student ${i} must NOT be blocked`);
    flagged += v.flags.length;
    clock.t += 25; // 200 students voting over ~5 seconds
  }

  assert.ok(flagged > 0, 'the anomaly should still be surfaced to the presenter as a flag');
  const flags = detector.stats().recentFlags;
  assert.ok(flags.some(f => f.rule === 'IP_FP_CARDINALITY'));
  assert.ok(flags.every(f => f.type === 'abuse:flag'), 'must be flags, not blocks');
});

test('IP cardinality CAN auto-block when an operator opts in for their environment', () => {
  const { detector } = makeDetector({ maxFingerprintsPerIp: 5, blockOnIpCluster: true });

  let blocked = null;
  for (let i = 0; i < 10 && !blocked; i++) {
    const v = detector.check({
      sessionId: 's1', voterKey: `d${i}_l${i}`, fingerprint: `d${i}`, ip: '7.7.7.7'
    });
    if (!v.allowed) blocked = v;
  }
  assert.ok(blocked);
  assert.strictEqual(blocked.rule, 'IP_FP_CARDINALITY');
});

// ---------------------------------------------------------------------------
// False positives: the legitimate voter must sail through
// ---------------------------------------------------------------------------

test('FALSE POSITIVE GUARD: a normal voter answering many polls is never blocked', () => {
  const { detector, clock } = makeDetector();
  // One device, one stable identity, one vote per poll, 30 polls over half an hour.
  for (let poll = 0; poll < 30; poll++) {
    const v = detector.check({
      sessionId: 's1', voterKey: 'gooddevice_goodlocal', fingerprint: 'gooddevice', ip: '198.51.100.4'
    });
    assert.strictEqual(v.allowed, true, `poll ${poll} must be allowed`);
    assert.deepStrictEqual(v.flags, []);
    clock.t += 60_000;
  }
});

test('FALSE POSITIVE GUARD: an enthusiastic user rapid-firing a few votes is not blocked', () => {
  const { detector, clock } = makeDetector();
  // Presenter is advancing polls fast; user answers 5 polls in 5 seconds. Fast, but human.
  for (let i = 0; i < 5; i++) {
    const v = detector.check({
      sessionId: 's1', voterKey: 'keendevice_keenlocal', fingerprint: 'keendevice', ip: '198.51.100.5'
    });
    assert.strictEqual(v.allowed, true);
    clock.t += 1_000;
  }
});

test('blocking one device does not block a different device on the same IP', () => {
  // Collateral-damage check: a flooder on shared wifi must not take their neighbours down.
  const { detector } = makeDetector();
  const ip = '203.0.113.50';

  for (let i = 0; i < 9; i++) {
    detector.check({ sessionId: 's1', voterKey: 'baddev_x', fingerprint: 'baddev', ip });
  }
  assert.strictEqual(
    detector.check({ sessionId: 's1', voterKey: 'baddev_x', fingerprint: 'baddev', ip }).allowed,
    false, 'the flooder is blocked'
  );
  assert.strictEqual(
    detector.check({ sessionId: 's1', voterKey: 'innocentdev_y', fingerprint: 'innocentdev', ip }).allowed,
    true, 'their neighbour on the same NAT must still vote'
  );
});

// ---------------------------------------------------------------------------
// Enforcement plumbing
// ---------------------------------------------------------------------------

test('a blocked flooder cannot extend their own ban by continuing to hammer', () => {
  const { detector, clock } = makeDetector();
  const bot = { voterKey: 'botdev_s1', fingerprint: 'botdev', ip: '10.0.0.9' };
  for (let i = 0; i < 9; i++) vote(detector, bot);

  // keep hammering for 30s while blocked
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(vote(detector, bot).allowed, false);
    clock.t += 300;
  }
  // the original 60s cooldown should still expire on schedule
  clock.t += 35_000;
  assert.strictEqual(vote(detector, bot).allowed, true, 'ban must not have been extended');
});

test('blocks are keyed per-scope and reported via stats()', () => {
  const { detector } = makeDetector();
  const bot = { voterKey: 'statdev_s1', fingerprint: 'statdev', ip: '10.0.0.42' };
  for (let i = 0; i < 9; i++) vote(detector, bot);

  const stats = detector.stats();
  assert.strictEqual(stats.activeBlocks.length, 1);
  assert.strictEqual(stats.activeBlocks[0].kind, 'fp');
  assert.strictEqual(stats.activeBlocks[0].value, 'statdev');
  assert.strictEqual(stats.activeBlocks[0].rule, 'FP_VOTE_RATE');
});

test('onEvent fires for blocks so they can be logged/alerted', () => {
  const events = [];
  const { detector } = makeDetector({ onEvent: (e) => events.push(e) });
  const bot = { voterKey: 'evdev_s1', fingerprint: 'evdev', ip: '10.0.0.7' };
  for (let i = 0; i < 9; i++) vote(detector, bot);

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'abuse:block');
  assert.strictEqual(events[0].rule, 'FP_VOTE_RATE');
});

test('detection is scoped per session: flooding poll A does not spend poll B budget', () => {
  const { detector } = makeDetector();
  const fp = 'multidev';
  for (let i = 0; i < 8; i++) {
    detector.check({ sessionId: 'sessionA', voterKey: `${fp}_k`, fingerprint: fp, ip: '1.1.1.1' });
  }
  // rate windows are per (session, fingerprint), so a different session starts fresh
  const v = detector.check({ sessionId: 'sessionB', voterKey: `${fp}_k`, fingerprint: fp, ip: '1.1.1.1' });
  assert.strictEqual(v.allowed, true);
});

test('sweep() bounds memory by dropping expired windows and blocks', () => {
  const { detector, clock } = makeDetector();
  for (let i = 0; i < 50; i++) {
    detector.check({ sessionId: 's1', voterKey: `d${i}_l${i}`, fingerprint: `d${i}`, ip: `10.0.0.${i}` });
  }
  assert.ok(detector.stats().trackedFingerprints > 0);

  clock.t += 120_000; // past every window and cooldown
  detector.sweep();
  const stats = detector.stats();
  assert.strictEqual(stats.trackedFingerprints, 0);
  assert.strictEqual(stats.activeBlocks.length, 0);
});

test('detector can be disabled by config (kill switch)', () => {
  const { detector } = makeDetector({ enabled: false });
  const bot = { voterKey: 'botdev_s1', fingerprint: 'botdev', ip: '10.0.0.9' };
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(vote(detector, bot).allowed, true);
  }
});

test('clientIpFromSocket reads the trusted (rightmost) hop, not the spoofable leftmost one', () => {
  // With trust proxy = 1, the trusted proxy appends the address it observed as the RIGHTMOST hop.
  // XFF "<client-as-proxy-saw-them>" with the proxy hop last => we key on the last hop.
  const legit = {
    handshake: { headers: { 'x-forwarded-for': '70.41.3.18, 203.0.113.9' }, address: '10.0.0.1' }
  };
  assert.strictEqual(clientIpFromSocket(legit), '203.0.113.9');

  // Attacker forges a leftmost hop: "1.2.3.4" is theirs, "203.0.113.9" is what the proxy appended.
  // The forged value must be ignored; we key on the trusted (rightmost) hop.
  const spoofed = {
    handshake: { headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }, address: '10.0.0.1' }
  };
  assert.strictEqual(clientIpFromSocket(spoofed), '203.0.113.9', 'forged leftmost hop must not be used');

  // Fallbacks
  assert.strictEqual(clientIpFromSocket({ handshake: { headers: {}, address: '10.0.0.1' } }), '10.0.0.1');
  assert.strictEqual(clientIpFromSocket({}), 'unknown');
});
