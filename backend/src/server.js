require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const connectDB = require('./config/db');

const authRoutes = require('./routes/auth.routes');
const sessionRoutes = require('./routes/session.routes');
const userRoutes = require('./routes/user.routes');
const pollRoutes = require('./routes/poll.routes');
const pollSocket = require('./sockets/pollSocket');

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/users', userRoutes);
app.use('/api/poll', pollRoutes);

app.use((req, res) => res.status(404).json({ message: 'Not found' }));

const PORT = process.env.PORT || 5000;
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: process.env.CLIENT_URL || '*' }
});
pollSocket(io);

connectDB().then(() => {
  httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});

module.exports = app;
