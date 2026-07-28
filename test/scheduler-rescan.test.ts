import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldEmitMonitorNotification,
  shouldSkipNotifiedFingerprint,
} from '../src/scheduler/monitor.js';

test('full rescan bypasses prior notification dedup so the listing is reanalyzed', () => {
  assert.equal(shouldSkipNotifiedFingerprint(true, true), false);
  assert.equal(shouldSkipNotifiedFingerprint(true, false), true);
  assert.equal(shouldSkipNotifiedFingerprint(false, true), false);
});

test('full rescan suppresses individual listing notifications', () => {
  assert.equal(shouldEmitMonitorNotification(true), false);
  assert.equal(shouldEmitMonitorNotification(false), true);
});
