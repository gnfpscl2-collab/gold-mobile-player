const GOLD_BUILDS = [
  ['0.1', '940bb0ce65f3ed960aa2bd3dfc1411389aa0f64189849dc5b1a3b3ec2bc4e9a1'],
  ['0.2', '6120e2ff614b9d5f743c66ba0e35d0f291b2f6b41666e4b9ae5278f53cab7aaa'],
  ['0.3', '69c1a08516c4ae1812265915324dfbe51356dcb8e978f6e1fa8180085c3c832a'],
  ['0.4', '48e4341338912b466c70e02322a5c8afbd406acb68a13031459b658fe976160d'],
  ['0.5', 'be8e982084bc78146e2da57eec0fe4dc89f1fd1caaf9735d9a76ec39c07539e9'],
  ['0.6', '271566534a72d5c55a9d038c8165f6e2599c6a0e6f3ad402152f4145ea61c397'],
  ['0.7', '31bb3b97a26fcd3288ac4185b1432e4c5091bff27cb02aa16d44a821051b3087'],
  ['0.7.1', '68067f4a0828091e5093c53897bd609a0022e02fd538178f33d8842db2a16478'],
  ['0.8', '305bda0d400ac8fa47cc19dee5f136394f4222bfb3fb045ac89f0ef8a253f32d'],
  ['0.9', '21d0c07167f9945367531d24330e1e16c19a1b8b35111478a8badd9360627a62'],
  ['0.9.1', 'e6b974d48da610a11d7e3fec0bd5d064f13ee1cc633b62f87cdcad5a4e9fb336'],
  ['0.9.2', '6e8ac761978f406a8fea5d737f498a17ff6a0c2ed685f7341806b20044ad197c'],
  ['0.9.3', 'be5509cb0fd3b72d73e017f53fab048048b8f15e9eac7397d00e122fc6ba6c42'],
  ['0.9.4', 'ec9b1fce57159bcb22c8ce552b1d329fd351a5f9e5bf7d7d222da2a68f89cb06'],
];
export const [LATEST_GOLD_VERSION, CURRENT_TRADE_BUILD] = GOLD_BUILDS.at(-1);
export const PREVIOUS_TRADE_BUILD = GOLD_BUILDS.at(-2)[1];
export const TRADE_BUILDS = Object.freeze(GOLD_BUILDS.map(([, hash]) => hash));

export function goldBuildVersion(hash) {
  return GOLD_BUILDS.find(([, build]) => build === hash)?.[0];
}
const CHANNEL_LABEL = 'gb-serial-v1';
const MAX_SDP_SIZE = 32_000;
const CONNECT_TIMEOUT = 45_000;

export function isSupportedTradeBuild(romHash) {
  return TRADE_BUILDS.includes(romHash);
}

function assertTradeBuild(romHash, expectedHash) {
  if (!isSupportedTradeBuild(romHash) || romHash !== expectedHash) {
    throw new Error('같은 개조판끼리만 교환할 수 있습니다.');
  }
}

function sameInvite(a, b) {
  return a != null && a.nonce === b.nonce && a.fromUid === b.fromUid && a.toUid === b.toUid && a.romHash === b.romHash;
}

function checkInvite(current, invite) {
  if (!sameInvite(current, invite) || current.status === 'closed') {
    throw new Error('교환 요청이 종료되었거나 바뀌었습니다.');
  }
}

function inviteRef(db, data, uid) {
  return data.doc(db, 'tradeInvites', uid);
}

function snapshotData(snapshot) {
  if (snapshot.metadata?.fromCache || snapshot.metadata?.hasPendingWrites) return undefined;
  return snapshot.data() ?? null;
}

export function watchTradeInvite({ db, data, uid, onChange, onError }) {
  return data.onSnapshot(inviteRef(db, data, uid), { includeMetadataChanges: true }, snapshot => {
    const current = snapshotData(snapshot);
    if (current !== undefined) onChange(current);
  }, onError);
}

export async function sendTradeInvite({ db, data, fromUid, toUid, romHash }) {
  assertTradeBuild(romHash, romHash);
  if (!fromUid || !toUid || fromUid === toUid) throw new Error('교환할 다른 사용자를 선택하세요.');
  const invite = { fromUid, toUid, romHash, nonce: crypto.randomUUID().replaceAll('-', ''), status: 'pending' };
  await data.setDoc(inviteRef(db, data, toUid), { ...invite, createdAt: data.serverTimestamp() });
  return invite;
}

export async function acceptTradeInvite({ db, data, invite, romHash }) {
  assertTradeBuild(romHash, invite?.romHash);
  const ref = inviteRef(db, data, invite.toUid);
  return data.runTransaction(db, async transaction => {
    const current = (await transaction.get(ref)).data();
    checkInvite(current, invite);
    if (current.status !== 'pending') throw new Error('이미 처리된 교환 요청입니다.');
    transaction.update(ref, { status: 'accepted' });
    return { ...current, status: 'accepted' };
  });
}

export async function closeTradeInvite({ db, data, invite, uid }) {
  if (uid !== invite.fromUid && uid !== invite.toUid) return;
  const ref = inviteRef(db, data, invite.toUid);
  await data.runTransaction(db, async transaction => {
    const current = (await transaction.get(ref)).data();
    if (!sameInvite(current, invite) || current.status === 'closed') return;
    transaction.update(ref, { status: 'closed' });
    if (current.status === 'offered') transaction.delete(data.doc(db, 'tradeSignals', invite.toUid));
  });
}

function aborted(signal) {
  return signal.reason || new Error('교환 연결이 취소되었습니다.');
}

function duringConnection(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted(signal));
    // Attach both handlers even after abort so a late network error is handled.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForDocument(data, ref, select, signal) {
  let unsubscribe;
  try {
    return await duringConnection(new Promise((resolve, reject) => {
      unsubscribe = data.onSnapshot(ref, { includeMetadataChanges: true }, snapshot => {
        const current = snapshotData(snapshot);
        if (current === undefined) return;
        try {
          if (select(current)) resolve(current);
        } catch (error) {
          reject(error);
        }
      }, reject);
    }), signal);
  } finally {
    unsubscribe?.();
  }
}

function watchEvent(target, type, select) {
  let listener;
  const promise = new Promise(resolve => {
    listener = event => {
      if (!select(event)) return;
      target.removeEventListener(type, listener);
      resolve(event);
    };
    target.addEventListener(type, listener);
  });
  return { promise, remove: () => target.removeEventListener(type, listener) };
}

function checkSdp(sdp) {
  if (typeof sdp !== 'string' || !sdp.length || sdp.length > MAX_SDP_SIZE) {
    throw new Error('교환 연결 정보가 올바르지 않습니다.');
  }
  return sdp;
}

async function localSdp(peer, description, signal) {
  await duringConnection(peer.setLocalDescription(description), signal);
  if (peer.iceGatheringState !== 'complete') {
    const completed = watchEvent(peer, 'icegatheringstatechange', () => peer.iceGatheringState === 'complete');
    try {
      await duringConnection(completed.promise, signal);
    } finally {
      completed.remove();
    }
  }
  return checkSdp(peer.localDescription?.sdp);
}

export async function connectTrade({ db, data, invite, uid, romHash, signal: externalSignal }) {
  assertTradeBuild(romHash, invite?.romHash);
  if (uid !== invite.fromUid && uid !== invite.toUid) throw new Error('교환 참여자만 접속할 수 있습니다.');
  if (externalSignal?.aborted) throw aborted(externalSignal);
  const controller = new AbortController();
  const signal = controller.signal;
  // shortcut: STUN only. Networks that require a TURN relay cannot connect.
  const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const ref = inviteRef(db, data, invite.toUid);
  const message = data.doc(db, 'tradeSignals', invite.toUid);
  const onExternalAbort = () => close(aborted(externalSignal));
  const onConnectionChange = () => {
    if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
      close(new Error('상대와 연결이 끊어졌습니다.'));
    }
  };
  const timeout = setTimeout(() => close(new Error('교환 연결 시간이 초과되었습니다.')), CONNECT_TIMEOUT);
  let channel;
  let incoming;
  let channelOpen;

  function close(reason) {
    if (signal.aborted) return;
    clearTimeout(timeout);
    controller.abort(reason);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    peer.removeEventListener('connectionstatechange', onConnectionChange);
    incoming?.remove();
    channelOpen?.remove();
    channel?.close();
    peer.close();
  }

  peer.addEventListener('connectionstatechange', onConnectionChange);
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    const initiating = uid === invite.fromUid;
    const current = await waitForDocument(data, ref, value => {
      checkInvite(value, invite);
      return initiating ? value.status === 'accepted' : value.status === 'offered';
    }, signal);

    if (initiating) {
      channel = peer.createDataChannel(CHANNEL_LABEL, { ordered: true });
      const offer = await localSdp(peer, await duringConnection(peer.createOffer(), signal), signal);
      const batch = data.writeBatch(db);
      batch.set(message, {
        nonce: current.nonce, inviteAt: current.createdAt, offeredAt: data.serverTimestamp(), offer, answer: null,
      });
      batch.update(ref, { status: 'offered' });
      await duringConnection(batch.commit(), signal);
      const { answer } = await waitForDocument(data, message, value => (
        value?.nonce === current.nonce && typeof value.answer === 'string'
      ), signal);
      await duringConnection(peer.setRemoteDescription({ type: 'answer', sdp: checkSdp(answer) }), signal);
    } else {
      const { offer } = await waitForDocument(data, message, value => (
        value?.nonce === current.nonce && typeof value.offer === 'string'
      ), signal);
      incoming = watchEvent(peer, 'datachannel', event => {
        const remote = event.channel;
        if (remote.label !== CHANNEL_LABEL || !remote.ordered
          || remote.maxRetransmits !== null || remote.maxPacketLifeTime !== null) {
          remote.close();
          return false;
        }
        remote.binaryType = 'arraybuffer';
        channel = remote;
        return true;
      });
      await duringConnection(peer.setRemoteDescription({ type: 'offer', sdp: checkSdp(offer) }), signal);
      const answer = await localSdp(peer, await duringConnection(peer.createAnswer(), signal), signal);
      await duringConnection(data.updateDoc(message, { answer }), signal);
      await duringConnection(incoming.promise, signal);
    }

    channel.binaryType = 'arraybuffer';
    if (channel.readyState !== 'open') {
      channelOpen = watchEvent(channel, 'open', () => true);
      await duringConnection(channelOpen.promise, signal);
    }
    clearTimeout(timeout);
    return { channel, close };
  } catch (error) {
    close(error);
    throw error;
  }
}
