import test from 'node:test';
import assert from 'node:assert/strict';
import { freshPresence, watchPresence } from './chat-presence.js';

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

test('presence refresh publishes a changed ROM build after an in-flight heartbeat and keeps legacy rows', async t => {
  const globals = { document: new EventTarget(), window: new EventTarget(), navigator: { onLine: true } };
  const descriptors = new Map();
  let presence;
  t.after(() => {
    presence?.stop();
    for (const [name, before] of descriptors) {
      if (before) Object.defineProperty(globalThis, name, before);
      else delete globalThis[name];
    }
  });
  for (const [name, value] of Object.entries(globals)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const tradeHash = '940bb0ce65f3ed960aa2bd3dfc1411389aa0f64189849dc5b1a3b3ec2bc4e9a1';
  const writes = [];
  let build;
  let onSnapshot;
  let online;
  let finishInitialWrite;
  const initialWrite = new Promise(resolve => { finishInitialWrite = resolve; });
  const data = {
    doc() {}, query() {}, collection() {}, orderBy() {}, limit() {}, serverTimestamp() {},
    onSnapshot(query, options, listener) {
      onSnapshot = listener;
      return () => {};
    },
    setDoc(ref, value) {
      writes.push(value);
      return writes.length === 1 ? initialWrite : Promise.resolve();
    },
  };
  presence = watchPresence({
    db: {}, data, uid: 'self', nickname: '테스트', getTradeBuild: () => build,
    onChange: rows => { online = rows; },
  });

  assert.equal(writes[0].tradeBuild, null);
  build = tradeHash;
  presence.refresh();
  assert.equal(writes.length, 1);
  finishInitialWrite();
  await initialWrite;
  assert.equal(writes[1].tradeBuild, tradeHash);
  const seenAt = { toMillis: () => Date.now() };
  onSnapshot({
    metadata: { fromCache: false },
    docs: [
      { data: () => ({ uid: 'self', nickname: '테스트', tradeBuild: tradeHash, seenAt }) },
      { data: () => ({ uid: 'legacy', nickname: '이전', seenAt }) },
    ],
  });
  assert.deepEqual(online, [
    { uid: 'self', nickname: '테스트', tradeBuild: tradeHash },
    { uid: 'legacy', nickname: '이전', tradeBuild: null },
  ]);
});
