const HEARTBEAT_MS = 45_000;
const LEASE_MS = 100_000;

export function freshPresence(leases, now = Date.now()) {
  return leases.filter(({ seenAt }) => Number.isFinite(seenAt) && now < seenAt + LEASE_MS);
}

export function watchPresence({ db, data, uid, nickname, onChange, getTradeBuild = () => null }) {
  const ownLease = data.doc(db, 'chatPresence', uid);
  const sessionId = crypto.randomUUID().replaceAll('-', '');
  const query = data.query(data.collection(db, 'chatPresence'), data.orderBy('seenAt', 'desc'), data.limit(100));
  let stopped = false;
  let inFlight;
  let pendingHeartbeat = false;
  let expiryTimer;
  let leases = [];

  function emitList() {
    if (stopped) return;
    clearTimeout(expiryTimer);
    const now = Date.now();
    const fresh = navigator.onLine ? freshPresence(leases, now) : [];
    onChange(fresh.map(({ uid, nickname, tradeBuild }) => ({ uid, nickname, tradeBuild })));
    if (fresh.length) {
      const nextExpiry = Math.min(...fresh.map(({ seenAt }) => seenAt + LEASE_MS));
      expiryTimer = setTimeout(emitList, Math.min(LEASE_MS, Math.max(1, nextExpiry - now)));
    }
  }

  async function heartbeat() {
    if (stopped || document.hidden || !navigator.onLine) return;
    if (inFlight) {
      pendingHeartbeat = true;
      return;
    }
    try {
      inFlight = data.setDoc(ownLease, {
        uid, nickname, sessionId, seenAt: data.serverTimestamp(), tradeBuild: getTradeBuild() ?? null,
      });
      await inFlight;
    } catch {
      // Failed updates expire naturally and the next heartbeat retries.
    } finally {
      inFlight = undefined;
      if (pendingHeartbeat) {
        pendingHeartbeat = false;
        void heartbeat();
      }
    }
  }

  function refresh() {
    emitList();
    void heartbeat();
  }

  const unsubscribe = data.onSnapshot(query, { includeMetadataChanges: true }, snapshot => {
    leases = snapshot.metadata.fromCache ? [] : snapshot.docs.map(doc => {
      const { uid, nickname, seenAt, tradeBuild = null } = doc.data();
      return { uid, nickname, tradeBuild, seenAt: seenAt?.toMillis?.() };
    });
    emitList();
  }, () => {
    leases = [];
    emitList();
  });
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', emitList);
  refresh();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
    clearTimeout(expiryTimer);
    unsubscribe();
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('online', refresh);
    window.removeEventListener('offline', emitList);
    onChange([]);
  }

  async function removeOwnLease() {
    stop();
    if (!navigator.onLine) return;
    await inFlight?.catch(() => {});
    if (!navigator.onLine) return;
    await data.runTransaction(db, async txn => {
      const snap = await txn.get(ownLease);
      if (snap.data()?.sessionId === sessionId) txn.delete(ownLease);
    });
  }

  return { stop, removeOwnLease, refresh };
}
