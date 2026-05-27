const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { OAuth2Client } = require('google-auth-library');
const bcrypt = require('bcryptjs');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const signToken = (user) =>
  jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '24h' });

exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email, password are required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'Email already registered' });

    const passwordHash = await User.hashPassword(password);
    const user = await User.create({ name, email, passwordHash });
    const token = signToken(user);

    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    const token = signToken(user);
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

exports.googleLogin = async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ message: 'Credential is required' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ message: 'Google login not configured' });
    }

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    let user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      user = await User.create({ 
        name, 
        email: email.toLowerCase(), 
        googleId, 
        authProvider: 'google' 
      });
    } else if (!user.googleId) {
      user.googleId = googleId;
      if (user.authProvider !== 'google') {
        user.authProvider = 'google';
      }
      await user.save();
    }

    const token = signToken(user);
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

exports.adminLogin = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USERNAME;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;
    if (!adminUser || !adminHash) {
      return res.status(503).json({ message: 'Admin login not configured' });
    }
    const userOk = typeof username === 'string' && username === adminUser;
    const passOk = typeof password === 'string' && (await bcrypt.compare(password, adminHash));
    if (!userOk || !passOk) {
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }
    const token = jwt.sign(
      { id: 'admin', email: 'admin@pollit.local', role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({
      token,
      user: { id: 'admin', name: 'Super Admin', email: 'admin@pollit.local', role: 'admin' }
    });
  } catch (err) {
    next(err);
  }
};
