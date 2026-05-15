const Session = require('../models/Session');
const Response = require('../models/Response');

// Public: audience joins by code
exports.joinByCode = async (req, res) => {
  try {
    const { code } = req.params;
    const session = await Session.findOne({ code }).lean();
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (session.status === 'ended') {
      return res.status(410).json({ message: 'Session has ended' });
    }

    // Strip presenter id and return safe view
    const currentPoll = session.currentPollIndex >= 0
      ? session.polls[session.currentPollIndex]
      : null;

    res.json({
      sessionId: session._id,
      title: session.title,
      status: session.status,
      currentPollIndex: session.currentPollIndex,
      currentPoll
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Public: audience submits a vote (REST fallback for now; sockets later)
exports.submitVote = async (req, res) => {
  try {
    const { code } = req.params;
    const { pollIndex, answer, voterKey } = req.body;

    if (pollIndex === undefined || answer === undefined || !voterKey) {
      return res.status(400).json({ message: 'pollIndex, answer, voterKey required' });
    }

    const session = await Session.findOne({ code });
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (session.status !== 'live') {
      return res.status(400).json({ message: 'Session is not live' });
    }
    if (session.currentPollIndex !== pollIndex) {
      return res.status(400).json({ message: 'This poll is not currently active' });
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
        return res.status(409).json({ message: 'Already voted on this poll' });
      }
      throw err;
    }

    res.status(201).json({ message: 'Vote recorded' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Presenter-only: control session lifecycle (live/end/next)
exports.startSession = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (session.presenter.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (session.polls.length === 0) {
      return res.status(400).json({ message: 'Add at least one poll first' });
    }
    session.status = 'live';
    session.currentPollIndex = 0;
    await session.save();
    res.json(session);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.nextPoll = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (session.presenter.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (session.status !== 'live') {
      return res.status(400).json({ message: 'Session is not live' });
    }
    if (session.currentPollIndex + 1 >= session.polls.length) {
      return res.status(400).json({ message: 'No more polls' });
    }
    session.currentPollIndex += 1;
    await session.save();
    res.json(session);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.endSession = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (session.presenter.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    session.status = 'ended';
    session.endedAt = new Date();
    await session.save();
    res.json(session);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
