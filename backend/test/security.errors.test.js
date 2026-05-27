const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = 'test_secret_min_32_chars_aaaaaaaaaaaa';
process.env.CLIENT_URL = 'https://allowed.example';
const request = require('supertest');
const app = require('../src/app');

test('malformed JSON returns a generic 400 with no leaked detail', async () => {
  const res = await request(app)
    .post('/api/auth/admin-login')
    .set('Content-Type', 'application/json')
    .send('{ this is not json');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.message, 'Invalid request');
  assert.ok(!res.body.error, 'response must not contain an error/stack field');
});
