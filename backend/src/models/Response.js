const mongoose = require('mongoose');

const responseSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
  pollIndex: { type: Number, required: true },
  answer: { type: mongoose.Schema.Types.Mixed, required: true },
  voterKey: { type: String, required: true }
}, { timestamps: true });

// One voter can answer a given poll in a session only once
responseSchema.index({ session: 1, pollIndex: 1, voterKey: 1 }, { unique: true });

module.exports = mongoose.model('Response', responseSchema);
