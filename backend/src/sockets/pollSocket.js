const jwt = require('jsonwebtoken');
const Session = require('../models/Session');
const Response = require('../models/Response');
const { generateInsights } = require('../services/aiInsightsService');
const { detector, deriveFingerprint, clientIpFromSocket } = require('../security/abuseDetector');

// Per-session in-memory state for AI throttling and audience count
const sessionState = new Map();
// shape: { audienceCount, lastInsightAt, votesSinceInsight, insightInFlight }

function getState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      audienceCount: 0,
      lastInsightAt: 0,
      votesSinceInsight: 0,
      insightInFlight: false
    });
  }
  return sessionState.get(sessionId);
}

function room(sessionId) { return `session:${sessionId}`; }

async function aggregateResults(sessionObjectId) {
  return Response.aggregate([
    { $match: { session: sessionObjectId } },
    { $group: { _id: { pollIndex: '$pollIndex', answer: '$answer' }, count: { $sum: 1 } } },
    {
      $group: {
        _id: '$_id.pollIndex',
        results: { $push: { answer: '$_id.answer', count: '$count' } },
        total: { $sum: '$count' }
      }
    },
    { $sort: { _id: 1 } }
  ]);
}

async function maybeGenerateInsights(io, session, currentPollIndex) {
  const state = getState(session._id.toString());
  const elapsed = Date.now() - state.lastInsightAt;
  const shouldFire = !state.insightInFlight &&
    (state.votesSinceInsight >= 5 || elapsed >= 10000);

  if (!shouldFire) return;

  state.insightInFlight = true;
  io.to(room(session._id.toString())).emit('insights:generating');

  try {
    const allResults = await aggregateResults(session._id);
    const pollResult = allResults.find(r => r._id === currentPollIndex);
    const poll = session.polls[currentPollIndex];
    if (!poll || !pollResult) {
      state.insightInFlight = false;
      return;
    }

    // Sample text answers for wordcloud/text types
    let textSamples = [];
    if (poll.type === 'text' || poll.type === 'wordcloud') {
      const docs = await Response.find({
        session: session._id,
        pollIndex: currentPollIndex
      }).limit(10).sort({ createdAt: -1 }).lean();
      textSamples = docs.map(d => d.answer).filter(a => typeof a === 'string');
    }

    // textSamples is raw audience free-text -- the prompt-injection surface. generateInsights()
    // guards it internally (src/security/promptGuard.js) before it reaches Gemini; we only ask to
    // be told when an attempt is caught so the presenter can see it.
    const insights = await generateInsights(poll, pollResult, textSamples, {
      onInjectionDetected: ({ detections, redactedCount }) => {
        io.to(room(session._id.toString())).emit('security:alert', {
          kind: 'prompt_injection',
          count: detections.length,
          redacted: redactedCount,
          rules: [...new Set(detections.flatMap(d => d.rules))],
          message: 'Prompt-injection attempt detected in open-text answers and neutralised.'
        });
      }
    });

    state.lastInsightAt = Date.now();
    state.votesSinceInsight = 0;
    state.insightInFlight = false;

    if (insights) {
      io.to(room(session._id.toString())).emit('insights:update', insights);
    }
  } catch (err) {
    console.error('Insights pipeline error:', err.message);
    state.insightInFlight = false;
  }
}

module.exports = function pollSocket(io) {
  io.on('connection', (socket) => {
    // Resolved once per connection. Behind Koyeb's proxy the real client IP is the LAST trusted
    // X-Forwarded-For hop (app.js sets trust proxy = 1), matching Express's req.ip on the REST
    // path. The leftmost hop is client-spoofable; clientIpFromSocket reads the trusted hop. We
    // still never make IP the sole blocking signal.
    socket.data.clientIp = clientIpFromSocket(socket);

    // Per-socket vote throttle: max 5 votes / second
    const voteTimestamps = [];
    function voteAllowed() {
      const now = Date.now();
      while (voteTimestamps.length && now - voteTimestamps[0] > 1000) voteTimestamps.shift();
      if (voteTimestamps.length >= 5) return false;
      voteTimestamps.push(now);
      return true;
    }

    // ------- Presenter joins their own session -------
    socket.on('presenter:join', async ({ sessionId, token }, ack) => {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const session = await Session.findById(sessionId);
        if (!session) return ack && ack({ ok: false, error: 'Session not found' });
        if (session.presenter.toString() !== decoded.id) {
          return ack && ack({ ok: false, error: 'Forbidden' });
        }
        socket.join(room(sessionId));
        socket.data.role = 'presenter';
        socket.data.sessionId = sessionId;

        const state = getState(sessionId);
        const allResults = await aggregateResults(session._id);

        ack && ack({
          ok: true,
          session,
          results: allResults,
          audienceCount: state.audienceCount
        });
      } catch (err) {
        ack && ack({ ok: false, error: 'Auth failed' });
      }
    });

    // ------- Presenter advances to next poll -------
    socket.on('presenter:nextPoll', async (_, ack) => {
      try {
        if (socket.data.role !== 'presenter') return ack && ack({ ok: false });
        const session = await Session.findById(socket.data.sessionId);
        if (!session || session.status !== 'live') return ack && ack({ ok: false });
        if (session.currentPollIndex + 1 >= session.polls.length) {
          return ack && ack({ ok: false, error: 'No more polls' });
        }
        session.currentPollIndex += 1;
        await session.save();

        // Reset insight state for new poll
        const state = getState(session._id.toString());
        state.votesSinceInsight = 0;
        state.lastInsightAt = 0;

        io.to(room(session._id.toString())).emit('poll:show', {
          currentPollIndex: session.currentPollIndex,
          poll: session.polls[session.currentPollIndex],
          totalPolls: session.polls.length
        });
        ack && ack({ ok: true });
      } catch (err) {
        ack && ack({ ok: false, error: 'Server error' });
      }
    });

    // ------- Presenter goes live (sets first poll + syncs audience) -------
    socket.on('presenter:goLive', async (_, ack) => {
      try {
        if (socket.data.role !== 'presenter') return ack && ack({ ok: false });
        const session = await Session.findById(socket.data.sessionId);
        if (!session) return ack && ack({ ok: false, error: 'Session not found' });
        if (session.status === 'ended') return ack && ack({ ok: false, error: 'Session has ended' });
        if (session.status === 'live') return ack && ack({ ok: false, error: 'Already live' });
        if (session.polls.length === 0) return ack && ack({ ok: false, error: 'Add at least one poll first' });

        session.status = 'live';
        session.currentPollIndex = 0;
        await session.save();

        const state = getState(session._id.toString());
        state.votesSinceInsight = 0;
        state.lastInsightAt = 0;

        io.to(room(session._id.toString())).emit('poll:show', {
          currentPollIndex: session.currentPollIndex,
          poll: session.polls[session.currentPollIndex],
          totalPolls: session.polls.length
        });
        ack && ack({ ok: true });
      } catch (err) {
        ack && ack({ ok: false, error: 'Server error' });
      }
    });

    // ------- Presenter ends the session -------
    socket.on('presenter:endSession', async (_, ack) => {
      try {
        if (socket.data.role !== 'presenter') return ack && ack({ ok: false });
        const session = await Session.findById(socket.data.sessionId);
        if (!session) return ack && ack({ ok: false });
        session.status = 'ended';
        session.endedAt = new Date();
        await session.save();
        io.to(room(session._id.toString())).emit('session:ended');
        ack && ack({ ok: true });
      } catch (err) {
        ack && ack({ ok: false });
      }
    });

    // ------- Presenter inserts an AI-suggested poll as the next one -------
    socket.on('presenter:insertPoll', async ({ poll }, ack) => {
      try {
        if (socket.data.role !== 'presenter') return ack && ack({ ok: false });
        if (!poll || !poll.question || !poll.type) {
          return ack && ack({ ok: false, error: 'Invalid poll' });
        }
        const session = await Session.findById(socket.data.sessionId);
        if (!session) return ack && ack({ ok: false });

        const insertAt = session.currentPollIndex + 1;
        session.polls.splice(insertAt, 0, {
          type: poll.type,
          question: poll.question,
          options: poll.options || []
        });
        await session.save();
        ack && ack({ ok: true, insertedAt: insertAt });
      } catch (err) {
        ack && ack({ ok: false, error: 'Server error' });
      }
    });

    // ------- Presenter adds a new poll mid-session (next or end; future-only) -------
    socket.on('presenter:addPoll', async ({ poll, position }, ack) => {
      try {
        if (socket.data.role !== 'presenter') return ack && ack({ ok: false });
        const validTypes = ['mcq', 'wordcloud', 'rating', 'text'];
        if (!poll || typeof poll.question !== 'string' || !poll.question.trim() ||
            !validTypes.includes(poll.type)) {
          return ack && ack({ ok: false, error: 'Invalid poll' });
        }
        const options = Array.isArray(poll.options)
          ? poll.options.map((o) => String(o).trim()).filter(Boolean)
          : [];
        if (poll.type === 'mcq' && options.length < 2) {
          return ack && ack({ ok: false, error: 'MCQ needs at least 2 options' });
        }
        if (position !== 'next' && position !== 'end') {
          return ack && ack({ ok: false, error: 'Invalid position' });
        }

        const session = await Session.findById(socket.data.sessionId);
        if (!session) return ack && ack({ ok: false, error: 'Session not found' });
        if (session.status === 'ended') return ack && ack({ ok: false, error: 'Session has ended' });

        const newPoll = {
          type: poll.type,
          question: poll.question.trim(),
          options: poll.type === 'mcq' ? options : []
        };

        let insertedAt;
        if (position === 'next') {
          // currentPollIndex + 1 is always a FUTURE (unanswered) index -> safe, no reindex of answered polls
          insertedAt = session.currentPollIndex + 1;
          session.polls.splice(insertedAt, 0, newPoll);
        } else {
          session.polls.push(newPoll);
          insertedAt = session.polls.length - 1;
        }
        await session.save();

        ack && ack({ ok: true, polls: session.polls, insertedAt });
      } catch (err) {
        ack && ack({ ok: false, error: 'Server error' });
      }
    });

    // ------- Audience joins by code -------
    socket.on('audience:join', async ({ code, voterKey }, ack) => {
      try {
        if (typeof code !== 'string' || code.length > 12) {
          return ack && ack({ ok: false, error: 'Invalid code' });
        }
        if (voterKey !== undefined && typeof voterKey !== 'string') {
          return ack && ack({ ok: false, error: 'Invalid voterKey' });
        }
        const session = await Session.findOne({ code });
        if (!session) return ack && ack({ ok: false, error: 'Session not found' });
        if (session.status === 'ended') {
          return ack && ack({ ok: false, error: 'Session has ended' });
        }
        socket.join(room(session._id.toString()));
        socket.data.role = 'audience';
        socket.data.sessionId = session._id.toString();
        socket.data.code = code;

        const state = getState(session._id.toString());
        state.audienceCount += 1;
        io.to(room(session._id.toString())).emit('audience:count', state.audienceCount);

        const currentPoll = session.currentPollIndex >= 0
          ? session.polls[session.currentPollIndex]
          : null;
          
        let hasVoted = false;
        if (session.currentPollIndex >= 0 && voterKey) {
          const existingVote = await Response.findOne({
            session: session._id,
            pollIndex: session.currentPollIndex,
            voterKey
          });
          if (existingVote) hasVoted = true;
        }

        ack && ack({
          ok: true,
          sessionId: session._id,
          title: session.title,
          status: session.status,
          currentPollIndex: session.currentPollIndex,
          currentPoll,
          totalPolls: session.polls.length,
          hasVoted
        });
      } catch (err) {
        ack && ack({ ok: false, error: 'Server error' });
      }
    });

    // ------- Audience submits a vote -------
    socket.on('audience:vote', async ({ pollIndex, answer, voterKey, fingerprint }, ack) => {
      try {
        // Socket-local throttle (cheap, first line). NOTE: this resets on reconnect, so it alone
        // does not stop a flooder who cycles sockets -- that is what the abuse detector below is
        // for, since its state is keyed on fingerprint/IP and survives reconnection.
        if (!voteAllowed()) return ack && ack({ ok: false, error: 'Rate limit' });
        if (typeof pollIndex !== 'number' || typeof voterKey !== 'string') {
          return ack && ack({ ok: false, error: 'Invalid vote' });
        }
        if (typeof answer !== 'string' && typeof answer !== 'number') {
          return ack && ack({ ok: false, error: 'Invalid answer' });
        }
        if (fingerprint !== undefined && typeof fingerprint !== 'string') {
          return ack && ack({ ok: false, error: 'Invalid fingerprint' });
        }
        const sessionId = socket.data.sessionId;
        if (!sessionId || !voterKey) return ack && ack({ ok: false });

        // ---- Abuse / anomaly detection (vote-rate spikes + fingerprint clustering) ----
        // The fingerprint is derived from voterKey (`${visitorId}_${localNonce}`) rather than
        // trusted from the client field, so a client that simply omits/forges `fingerprint`
        // still gets clustered by the device id embedded in the voterKey it must send anyway.
        const fp = deriveFingerprint(voterKey) || (typeof fingerprint === 'string' ? fingerprint : null);
        const verdict = detector.check({
          sessionId,
          voterKey,
          fingerprint: fp,
          ip: socket.data.clientIp
        });

        if (!verdict.allowed) {
          // Tell the offender (so a false-positive user sees why they are stuck)...
          socket.emit('abuse:blocked', {
            rule: verdict.rule,
            reason: verdict.reason,
            retryAfterMs: verdict.retryAfterMs
          });
          // ...and alert the presenter's room that an attack is in progress.
          io.to(room(sessionId)).emit('security:alert', {
            kind: 'vote_abuse',
            rule: verdict.rule,
            scope: verdict.scope,
            message: 'Automated voting detected and blocked.'
          });
          return ack && ack({ ok: false, error: verdict.reason, retryAfterMs: verdict.retryAfterMs });
        }

        // Non-blocking anomalies (e.g. many devices behind one NAT) -- surface, do not punish.
        if (verdict.flags && verdict.flags.length) {
          io.to(room(sessionId)).emit('security:alert', {
            kind: 'vote_anomaly',
            rule: verdict.flags[0].rule,
            message: verdict.flags[0].note
          });
        }

        const session = await Session.findById(sessionId);
        if (!session || session.status !== 'live') {
          return ack && ack({ ok: false, error: 'Session not live' });
        }
        if (session.currentPollIndex !== pollIndex) {
          return ack && ack({ ok: false, error: 'Poll no longer active' });
        }

        try {
          await Response.create({
            session: session._id,
            pollIndex,
            answer,
            voterKey
          });
        } catch (err) {
          if (err.code === 11000) {
            return ack && ack({ ok: false, error: 'Already voted' });
          }
          throw err;
        }

        // Re-aggregate and emit
        const allResults = await aggregateResults(session._id);
        io.to(room(sessionId)).emit('results:update', allResults);

        // Trigger AI insights (throttled)
        const state = getState(sessionId);
        state.votesSinceInsight += 1;
        // Fire and forget — never block the vote ack
        maybeGenerateInsights(io, session, pollIndex).catch(() => {});

        ack && ack({ ok: true });
      } catch (err) {
        ack && ack({ ok: false, error: 'Server error' });
      }
    });

    // ------- Cleanup on disconnect -------
    socket.on('disconnect', () => {
      if (socket.data.role === 'audience' && socket.data.sessionId) {
        const state = getState(socket.data.sessionId);
        state.audienceCount = Math.max(0, state.audienceCount - 1);
        io.to(room(socket.data.sessionId)).emit('audience:count', state.audienceCount);
      }
    });
  });
};
