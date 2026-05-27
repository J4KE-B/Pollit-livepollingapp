const User = require('../models/User');
const Session = require('../models/Session');

exports.getAllUsers = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden: Admin access required' });
    }

    const users = await User.aggregate([
      {
        $lookup: {
          from: 'sessions',
          localField: '_id',
          foreignField: 'presenter',
          as: 'sessions'
        }
      },
      {
        $project: {
          name: 1,
          email: 1,
          authProvider: 1,
          createdAt: 1,
          sessionCount: { $size: '$sessions' }
        }
      },
      { $sort: { createdAt: -1 } }
    ]);

    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
