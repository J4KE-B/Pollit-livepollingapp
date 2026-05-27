// Comma-separated list of allowed origins, e.g. "https://pollit.vercel.app,https://www.pollit.app"
const allowedOrigins = process.env.CLIENT_URL ? process.env.CLIENT_URL.split(',') : ['http://localhost:4200'];

const originCheck = (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) {
    callback(null, true);
  } else {
    callback(new Error('Not allowed by CORS'));
  }
};

const corsOptions = {
  origin: originCheck,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
};

module.exports = { allowedOrigins, corsOptions, originCheck };
