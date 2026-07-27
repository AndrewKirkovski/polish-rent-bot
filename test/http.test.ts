import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminTokenMatches,
  extractAdminToken,
  parseCacheResetScope,
} from '../src/server/http.js';

test('cache reset scope accepts only documented values', () => {
  for (const scope of ['all', 'location', 'maps', 'ai']) {
    assert.equal(parseCacheResetScope(scope), scope);
  }
  assert.equal(parseCacheResetScope('everything'), null);
  assert.equal(parseCacheResetScope(undefined), null);
  assert.equal(parseCacheResetScope(123), null);
});

test('admin token extraction prefers a bearer token and supports the explicit header', () => {
  assert.equal(extractAdminToken('Bearer secret', 'fallback'), 'secret');
  assert.equal(extractAdminToken('bearer secret-two', undefined), 'secret-two');
  assert.equal(extractAdminToken(undefined, ' secret-three '), 'secret-three');
  assert.equal(extractAdminToken('Basic ignored', undefined), null);
});

test('admin token comparison requires an exact non-empty match', () => {
  assert.equal(adminTokenMatches('secret', 'secret'), true);
  assert.equal(adminTokenMatches('secret', 'Secret'), false);
  assert.equal(adminTokenMatches('secret', 'secret-extra'), false);
  assert.equal(adminTokenMatches('', ''), false);
  assert.equal(adminTokenMatches(undefined, 'secret'), false);
});
