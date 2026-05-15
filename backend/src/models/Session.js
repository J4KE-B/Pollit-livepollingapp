const mongoose = require('mongoose');

const pollSchema = new mongoose.Schema({
  type: { type: String, enum: ['mcq', 'wordcloud', 'rating', 'text'], required: true },
  question: { type: String, required: true, trim: true },
  options: { type: [String], default: [] }
}, { _id: true });

const sessionSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true, trim: true },
  presenter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  polls: { type: [pollSchema], default: [] },
  currentPollIndex: { type: Number, default: -1 },
  status: { type: String, enum: ['draft', 'live', 'ended'], default: 'draft' },
  endedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Session', sessionSchema);
