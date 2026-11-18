import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_TRADE_BUILD, PREVIOUS_TRADE_BUILD, acceptTradeInvite, closeTradeInvite, connectTrade, sendTradeInvite, watchTradeInvite,
} from './trade-signaling.js';

test('a mismatched ROM is refused before sending, accepting or opening the trade', async () => {
  const options = { romHash: 'different', fromUid: 'alice', toUid: 'bob' };
  await assert.rejects(sendTradeInvite(options), /개조판/);
  await assert.rejects(acceptTradeInvite(options), /개조판/);
  await assert.rejects(connectTrade(options), /개조판/);
  const crossBuild = { romHash: CURRENT_TRADE_BUILD, invite: { romHash: PREVIOUS_TRADE_BUILD } };
  await assert.rejects(acceptTradeInvite(crossBuild), /개조판/);
  await assert.rejects(connectTrade(crossBuild), /개조판/);
});

test('trade actions use only the selected recipient mailbox and clean up its matching offer', async () => {
  const writes = [];
  let current;
  const data = {
    doc: (_db, path, uid) => `${path}/${uid}`,
    serverTimestamp: () => 'server-time',
    async setDoc(ref, value) {
      writes.push(['set', ref, value.status]);
      current = value;
    },
    async runTransaction(db, callback) {
      return callback({
        get: async () => ({ data: () => current }),
        update(ref, value) {
          writes.push(['update', ref, value.status]);
          current = { ...current, ...value };
        },
        delete: ref => writes.push(['delete', ref]),
      });
    },
  };
  const args = { db: {}, data, fromUid: 'alice', toUid: 'bob', romHash: CURRENT_TRADE_BUILD };
  const invite = await sendTradeInvite(args);
  assert.match(invite.nonce, /^[0-9a-f]{32}$/);
  await assert.rejects(acceptTradeInvite({ ...args, invite: { ...invite, nonce: 'outdated' } }), /바뀌었습니다/);
  current = { ...current, romHash: PREVIOUS_TRADE_BUILD };
  await assert.rejects(acceptTradeInvite({ ...args, invite }), /바뀌었습니다/);
  current = { ...current, romHash: CURRENT_TRADE_BUILD };
  const accepted = await acceptTradeInvite({ ...args, invite });
  assert.equal(accepted.status, 'accepted');
  current = { ...accepted, status: 'offered' };
  await closeTradeInvite({ ...args, invite, uid: 'other' });
  await closeTradeInvite({ ...args, invite, uid: 'alice' });
  assert.deepEqual(writes, [
    ['set', 'tradeInvites/bob', 'pending'],
    ['update', 'tradeInvites/bob', 'accepted'],
    ['update', 'tradeInvites/bob', 'closed'],
    ['delete', 'tradeSignals/bob'],
  ]);
});

test('the inbox does not expose locally pending or cached invitations to UI', () => {
  let listener;
  const updates = [];
  const data = {
    doc: (_db, path, uid) => `${path}/${uid}`,
    onSnapshot(ref, options, callback) {
      assert.equal(ref, 'tradeInvites/bob');
      assert.deepEqual(options, { includeMetadataChanges: true });
      listener = callback;
    },
  };
  watchTradeInvite({ db: {}, data, uid: 'bob', onChange: value => updates.push(value) });
  const snapshot = { data: () => ({ nonce: 'request' }) };
  listener({ ...snapshot, metadata: { fromCache: true } });
  listener({ ...snapshot, metadata: { hasPendingWrites: true } });
  listener({ ...snapshot, metadata: {} });
  listener({ data: () => undefined, metadata: {} });
  assert.deepEqual(updates, [{ nonce: 'request' }, null]);
});

test('the accepted offer and answer open two reliable channels without putting game data in Firestore', async t => {
  const invite = { fromUid: 'alice', toUid: 'bob', nonce: 'matching', romHash: PREVIOUS_TRADE_BUILD, createdAt: 123, status: 'accepted' };
  const docs = new Map([['tradeInvites/bob', invite]]);
  const listeners = new Map();
  const channels = [];
  class Channel extends EventTarget {
    label = 'gb-serial-v1';
    ordered = true;
    maxRetransmits = null;
    maxPacketLifeTime = null;
    readyState = 'connecting';
    close() { this.readyState = 'closed'; }
  }
  class Peer extends EventTarget {
    iceGatheringState = 'complete';
    async createOffer() { return { type: 'offer', sdp: 'mock offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'mock answer' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription({ type }) {
      if (type === 'offer') {
        const event = new Event('datachannel');
        event.channel = this.createDataChannel();
        this.dispatchEvent(event);
      } else {
        for (const channel of channels) {
          channel.readyState = 'open';
          channel.dispatchEvent(new Event('open'));
        }
      }
    }
    createDataChannel() {
      const channel = new Channel();
      channels.push(channel);
      return channel;
    }
    close() {}
  }
  const previousPeer = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = Peer;
  t.after(() => {
    if (previousPeer === undefined) delete globalThis.RTCPeerConnection;
    else globalThis.RTCPeerConnection = previousPeer;
  });

  function snapshot(key) {
    return { data: () => docs.get(key), metadata: {} };
  }
  function publish(key, value) {
    docs.set(key, value);
    for (const listener of listeners.get(key) || []) listener(snapshot(key));
  }
  const data = {
    doc: (_db, path, uid) => `${path}/${uid}`,
    serverTimestamp: () => 'server time',
    onSnapshot(key, options, callback) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(callback);
      queueMicrotask(() => callback(snapshot(key)));
      return () => listeners.get(key).delete(callback);
    },
    writeBatch() {
      const writes = [];
      return {
        set: (key, value) => writes.push(() => publish(key, value)),
        update: (key, value) => writes.push(() => publish(key, { ...docs.get(key), ...value })),
        async commit() { writes.forEach(write => write()); },
      };
    },
    async updateDoc(key, value) { publish(key, { ...docs.get(key), ...value }); },
  };

  const options = { db: {}, data, invite, romHash: PREVIOUS_TRADE_BUILD };
  const [initiating, receiving] = await Promise.all([
    connectTrade({ ...options, uid: 'alice' }),
    connectTrade({ ...options, uid: 'bob' }),
  ]);
  t.after(() => {
    initiating.close();
    receiving.close();
  });
  assert.equal(docs.get('tradeInvites/bob').status, 'offered');
  assert.deepEqual(docs.get('tradeSignals/bob'), {
    nonce: invite.nonce, inviteAt: 123, offeredAt: 'server time', offer: 'mock offer', answer: 'mock answer',
  });
  for (const session of [initiating, receiving]) {
    assert.equal(session.channel.readyState, 'open');
    assert.equal(session.channel.binaryType, 'arraybuffer');
  }
});
