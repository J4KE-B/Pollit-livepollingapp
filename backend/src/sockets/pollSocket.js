const jwt = require('jsonwebtoken');
const Session = require('../models/Session');
const Response = require('../models/Response');
const { generateInsights } = require('../services/aiInsightsService');

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

    const insights = await generateInsights(poll, pollResult, textSamples);

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
          poll: session.polls[session.currentPollIndex]
        });
        ack && ack({ ok: true });
      } catch (err) {
        ack && ack({ ok: false, error: err.message });
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
        ack && ack({ ok: false, error: err.message });
      }
    });

    // ------- Audience joins by code -------
    socket.on('audience:join', async ({ code }, ack) => {
      try {
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

        ack && ack({
          ok: true,
          sessionId: session._id,
          title: session.title,
          status: session.status,
          currentPollIndex: session.currentPollIndex,
          currentPoll
        });
      } catch (err) {
        ack && ack({ ok: false, error: err.message });
      }
    });

    // ------- Audience submits a vote -------
    socket.on('audience:vote', async ({ pollIndex, answer, voterKey }, ack) => {
      try {
        const sessionId = socket.data.sessionId;
        if (!sessionId || !voterKey) return ack && ack({ ok: false });

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
        ack && ack({ ok: false, error: err.message });
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
