const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = 'test_secret_min_32_chars_aaaaaaaaaaaa';
process.env.CLIENT_URL = 'https://allowed.example';
const request = require('supertest');
const app = require('../src/app');

test('helmet sets X-Content-Type-Options: nosniff', async () => {
  const res = await request(app).get('/api/health');
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
});
test('allowed origin receives a matching CORS header', async () => {
  const res = await request(app).get('/api/health').set('Origin', 'https://allowed.example');
  assert.strictEqual(res.headers['access-control-allow-origin'], 'https://allowed.example');
});
test('disallowed origin receives NO CORS header', async () => {
  const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
  assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
});
