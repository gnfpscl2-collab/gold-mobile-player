import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPresence } from './chat-presence.js';

test('presence ignores unresolved leases and stops showing a nickname at the expiry boundary', () => {
  const now = 1_700_000_000_000;
  const leases = [
    { uid: 'last-millisecond', seenAt: now - 99_999 },
    { uid: 'expired', seenAt: now - 100_000 },
    { uid: 'new', seenAt: now },
    { uid: 'pending', seenAt: null },
    { uid: 'invalid', seenAt: Number.NaN },
  ];
  assert.deepEqual(freshPresence(leases, now).map(({ uid }) => uid), ['last-millisecond', 'new']);
  assert.deepEqual(freshPresence(leases, now + 1).map(({ uid }) => uid), ['new']);
});
