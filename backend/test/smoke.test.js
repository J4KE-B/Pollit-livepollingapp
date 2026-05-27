const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = 'test_secret_min_32_chars_aaaaaaaaaaaa';
process.env.CLIENT_URL = 'https://allowed.example';
const request = require('supertest');
const app = require('../src/app');

test('smoke: Express boots without MongoDB', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
});
