const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'test_secret_min_32_chars_aaaaaaaaaaaa';
process.env.CLIENT_URL = 'https://allowed.example';
process.env.AUTH_RATE_LIMIT_MAX = '2';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('x', 10);
const request = require('supertest');
const app = require('../src/app');

test('auth endpoints return 429 after exceeding the limit', async () => {
  // admin-login touches no DB, so it is safe to hammer in tests
  await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 'wrong' });
  await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 'wrong' });
  const res = await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 'wrong' });
  assert.strictEqual(res.status, 429);
});
