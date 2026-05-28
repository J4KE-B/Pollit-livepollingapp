// Comma-separated list of allowed origins, e.g. "https://pollit.vercel.app,https://www.pollit.app"
// Normalize so a stray trailing slash or whitespace in CLIENT_URL doesn't cause a mismatch.
const normalize = (o) => (o || '').trim().replace(/\/+$/, '');

const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:4200')
  .split(',')
  .map(normalize)
  .filter(Boolean);

const originCheck = (origin, callback) => {
  // Allow non-browser / same-origin requests (no Origin header) and whitelisted origins.
  if (!origin || allowedOrigins.includes(normalize(origin))) {
    return callback(null, true);
  }
  console.warn('[cors] blocked origin:', origin, '| allowed:', allowedOrigins);
  return callback(null, false); // disallowed: no CORS headers (browser blocks), no 500 noise
};

const corsOptions = {
  origin: originCheck,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// One-time startup log so we can confirm from Render's logs what CLIENT_URL resolved to.
console.log('[cors] allowed origins:', allowedOrigins);

module.exports = { allowedOrigins, corsOptions, originCheck };
