const Session = require('../models/Session');
const Response = require('../models/Response');
const { generateUniqueCode } = require('../utils/codeGenerator');

exports.createSession = async (req, res) => {
  try {
    const { title, polls } = req.body;
    if (!title) return res.status(400).json({ message: 'title is required' });

    const code = await generateUniqueCode();
    const session = await Session.create({
      code,
      title,
      presenter: req.user.id,
      polls: polls || [],
      currentPollIndex: -1,
      status: 'draft'
    });

    res.status(201).json(session);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.getMySessions = async (req, res) => {
  try {
    const sessions = await Session.find({ presenter: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.getSessionById = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (session.presenter.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    res.json(session);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.updateSession = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (session.presenter.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (session.status === 'ended') {
      return res.status(400).json({ message: 'Cannot edit ended session' });
    }

    const { title, polls } = req.body;
    if (title !== undefined) session.title = title;
    if (polls !== undefined) session.polls = polls;

    await session.save();
    res.json(session);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.deleteSession = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (session.presenter.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    await Response.deleteMany({ session: session._id });
    await session.deleteOne();
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.getSessionResults = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (session.presenter.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const aggregated = await Response.aggregate([
      { $match: { session: session._id } },
      {
        $group: {
          _id: { pollIndex: '$pollIndex', answer: '$answer' },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: '$_id.pollIndex',
          results: { $push: { answer: '$_id.answer', count: '$count' } },
          total: { $sum: '$count' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({ session, results: aggregated });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
