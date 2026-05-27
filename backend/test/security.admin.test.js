const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'test_secret_min_32_chars_aaaaaaaaaaaa';
process.env.CLIENT_URL = 'https://allowed.example';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('s3cretAdminPass', 10);
const request = require('supertest');
const app = require('../src/app');

test('admin login rejects the old hardcoded password', async () => {
  const res = await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 'admin123' });
  assert.strictEqual(res.status, 401);
  assert.ok(!res.body.token);
});
test('admin login accepts correct env credentials and returns an admin token', async () => {
  const res = await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 's3cretAdminPass' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token);
  assert.strictEqual(res.body.user.role, 'admin');
});
test('admin login returns 503 when not configured', async () => {
  const saved = process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_PASSWORD_HASH;
  const res = await request(app).post('/api/auth/admin-login').send({ username: 'admin', password: 'x' });
  assert.strictEqual(res.status, 503);
  process.env.ADMIN_PASSWORD_HASH = saved;
});
