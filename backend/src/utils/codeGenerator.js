const Session = require('../models/Session');

async function generateUniqueCode(maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const existing = await Session.findOne({ code }).lean();
    if (!existing) return code;
  }
  throw new Error('Could not generate unique code');
}

module.exports = { generateUniqueCode };
