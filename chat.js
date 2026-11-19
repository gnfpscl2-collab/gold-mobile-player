import { firebaseConfig } from './chat-config.js?v=1.5.0';
import { watchPresence } from './chat-presence.js?v=1.8.0';

const sdk = 'https://www.gstatic.com/firebasejs/13.3.0/';
const allowedEmail = /^[^@\s]+@(?:gmail\.com|naver\.com)$/i;
const byId = id => document.getElementById(id);

export function nicknameFor(input) {
  const nickname = input.normalize('NFC');
  return /^[A-Za-z가-힣]+$/.test(nickname) && nickname.replace(/[가-힣]/g, 'aa').length <= 12 ? nickname : null;
}

export function messageSlot(seq) {
  return 'm' + (seq % 100);
}

export function compatibleTradePeers(players, build, myUid) {
  return build ? players.filter(player => player.tradeBuild === build && player.uid !== myUid) : [];
}

export function cooldownUntil(rate) {
  const latest = rate?.createdAt?.toMillis();
  const first = rate?.firstOfThreeAt?.toMillis();
  if (latest == null) return 0;
  return latest + (first != null && latest - first <= 10000 ? 15000 : 3000);
}

function report(id, message) {
  const element = byId(id);
  element.textContent = message;
  element.hidden = !message;
}

async function connectChat(authButton) {
  const [{ initializeApp }, account, data] = await Promise.all([
    import(sdk + 'firebase-app.js'),
    import(sdk + 'firebase-auth.js'),
    import(sdk + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(firebaseConfig, 'player-chat');
  const auth = account.getAuth(app);
  auth.languageCode = 'ko';
  const db = data.getFirestore(app);
  const messages = data.collection(db, 'chatMessages');
  const login = byId('chat-login');
  const loginDialog = byId('chat-auth-dialog');
  const verifyDialog = byId('chat-verify-dialog');
  const openVerify = byId('chat-open-verify');
  const profileForm = byId('chat-profile');
  const nameField = byId('chat-nickname');
  const onlineButton = byId('chat-online-toggle');
  const onlineList = byId('chat-online');
  const room = byId('chat-room');
  const log = byId('chat-messages');
  const entry = byId('chat-message');
  const send = byId('chat-send');
  const setStatus = message => report('chat-status', message);
  const loginStatus = message => report('chat-login-status', message);
  const verifyStatus = message => report('chat-verify-status', message);
  let unsubscribeRoom;
  let presence;
  let lastRate;
  let authPending = false;
  let posting = false;
  let profile;
  let session = 0;
  let playersOnline = [];
  let showCompatibleOnly = false;
  const screen = byId('screen');
  const getTradeBuild = () => byId('screen').dataset.tradeBuild || null;
  const tradeEnabled = () => screen.dataset.tradeLink === 'true';
  const tradeReady = () => tradeEnabled() && screen.dataset.tradeReady === 'true';
  const tradePanel = byId('trade-controls');
  const tradeStatus = byId('trade-status');
  const tradeAccept = byId('trade-accept');
  const tradeCancel = byId('trade-cancel');
  let tradeApi;
  let stopInvites;
  let incoming;
  let flow;
  let heldForTrade = false;
  let tradeNotice = '';

  function holdForTrade() {
    if (!heldForTrade && tradeReady()) {
      heldForTrade = true;
      document.dispatchEvent(new Event('player-trade-hold'));
    }
  }

  function releaseTradeHold() {
    if (!heldForTrade) return;
    heldForTrade = false;
    document.dispatchEvent(new Event('player-trade-release'));
  }

  function pendingInvite() {
    if (incoming?.status !== 'pending') return null;
    const created = incoming.createdAt?.toMillis();
    return created != null && Date.now() - created < 120000 ? incoming : null;
  }

  function renderTrade() {
    const request = pendingInvite();
    const canAnswer = Boolean(!flow && request);
    tradeAccept.hidden = !canAnswer;
    tradeAccept.disabled = !tradeReady() || request?.romHash !== getTradeBuild();
    tradeCancel.hidden = !flow && !canAnswer && !heldForTrade;
    tradeCancel.textContent = canAnswer ? '거절' : '취소';
    const nickname = playersOnline.find(player => player.uid === request?.fromUid)?.nickname || '상대';
    const prompt = canAnswer && (nickname + ' 님이 교환을 요청했습니다.'
      + (tradeAccept.disabled ? ' 게임에서 교환 대기를 시작한 뒤 수락하세요.' : ''));
    const message = flow?.status || prompt || tradeNotice
      || (heldForTrade ? '교환할 닉네임을 선택하세요.' : '');
    tradePanel.hidden = !profile || !tradeEnabled() || !message;
    tradeStatus.textContent = message;
  }

  function beginTrade(uid, peerUid, outgoing, status) {
    const request = { uid, peerUid, outgoing, status, controller: new AbortController() };
    request.timer = setTimeout(() => finishTrade(request, '교환 요청 시간이 지났습니다.'), 60000);
    flow = request;
    tradeNotice = '';
    renderOnline(playersOnline);
    return request;
  }

  function finishTrade(request, message, keepWaiting = false) {
    if (request !== flow) return;
    flow = undefined;
    clearTimeout(request.timer);
    request.stopWatch?.();
    request.controller.abort();
    request.link?.close();
    if (incoming?.nonce === request.invite?.nonce) incoming = undefined;
    if (!keepWaiting) releaseTradeHold();
    tradeNotice = message;
    renderOnline(playersOnline);
    if (request.invite) {
      return tradeApi.closeTradeInvite({ db, data, invite: request.invite, uid: request.uid }).catch(() => {});
    }
  }

  async function connectTrade(request) {
    if (request !== flow || request.connecting) return;
    if (!tradeReady() || request.invite.romHash !== getTradeBuild()) {
      return finishTrade(request, '게임에서 교환 대기를 시작한 뒤 다시 시도하세요.');
    }
    request.connecting = true;
    request.status = '상대와 연결하는 중…';
    renderTrade();
    try {
      const link = await tradeApi.connectTrade({
        db, data, invite: request.invite, uid: request.uid, romHash: getTradeBuild(), signal: request.controller.signal,
      });
      if (request !== flow) return link.close();
      clearTimeout(request.timer);
      request.link = link;
      request.status = '연결됐습니다. 게임 화면에서 교환하세요.';
      renderTrade();
      heldForTrade = false;
      const outcomes = {
        complete: '교환이 끝났습니다.',
        failed: '교환 연결이 끊겼습니다. 다시 시도하세요.',
        unavailable: '교환 대기 상태가 바뀌었습니다.',
        cancelled: '교환을 취소했습니다.',
      };
      document.dispatchEvent(new CustomEvent('player-trade-connect', {
        detail: {
          channel: link.channel, initiator: request.outgoing, romHash: request.invite.romHash,
          finish: reason => finishTrade(request, outcomes[reason] || outcomes.failed),
        },
      }));
    } catch {
      finishTrade(request, '상대와 연결하지 못했습니다. 다시 시도하세요.');
    }
  }

  async function invitePlayer(player) {
    const uid = auth.currentUser?.uid;
    if (!profile || !uid || !tradeApi || !tradeReady() || flow || pendingInvite()
      || !compatibleTradePeers(playersOnline, getTradeBuild(), uid).some(peer => peer.uid === player.uid)) return;
    if (!navigator.onLine) {
      tradeNotice = '인터넷에 연결한 뒤 다시 시도하세요.';
      return renderTrade();
    }
    const request = beginTrade(uid, player.uid, true, player.nickname + ' 님에게 교환을 요청하는 중…');
    try {
      const invite = await tradeApi.sendTradeInvite({ db, data, fromUid: uid, toUid: player.uid, romHash: getTradeBuild() });
      if (flow !== request) return tradeApi.closeTradeInvite({ db, data, invite, uid }).catch(() => {});
      request.invite = invite;
      request.status = player.nickname + ' 님의 응답을 기다리는 중…';
      renderTrade();
      request.stopWatch = tradeApi.watchTradeInvite({ db, data, uid: player.uid, onChange: current => {
        if (request !== flow) return;
        if (current?.nonce !== invite.nonce || current.status === 'closed') {
          finishTrade(request, '상대가 교환 요청을 종료했습니다.');
        } else if (current.status === 'accepted' || current.status === 'offered') {
          request.invite = current;
          connectTrade(request);
        }
      }, onError: () => finishTrade(request, '상대의 응답을 확인하지 못했습니다.') });
    } catch {
      finishTrade(request, '교환 요청을 보내지 못했습니다. 잠시 뒤 다시 시도하세요.');
    }
  }

  function watchInvites(uid) {
    if (!tradeEnabled() || stopInvites) return;
    let stopped = false;
    let unsubscribe;
    stopInvites = () => { stopped = true; unsubscribe?.(); };
    import('./trade-signaling.js?v=1.8.8').then(api => {
      if (stopped) return;
      tradeApi = api;
      unsubscribe = api.watchTradeInvite({ db, data, uid, onChange: invite => {
        if (stopped) return;
        incoming = invite;
        if (flow?.outgoing === false && (invite?.nonce !== flow.invite.nonce || invite.status === 'closed')) {
          finishTrade(flow, '상대가 교환 요청을 종료했습니다.');
        } else if (flow?.outgoing && !flow.connecting && invite?.status === 'pending'
          && invite.fromUid === flow.peerUid && uid > invite.fromUid) {
          // Simultaneous reverse invites converge on the request from the smaller UID.
          finishTrade(flow, '', true);
        }
        renderOnline(playersOnline);
      }, onError: () => {
        if (stopped) return;
        tradeNotice = '교환 요청을 불러오지 못했습니다.';
        renderTrade();
      } });
      renderOnline(playersOnline);
    }).catch(() => {
      if (stopped) return;
      stopInvites = undefined;
      tradeNotice = '교환 기능을 불러오지 못했습니다.';
      renderTrade();
    });
  }

  function renderMessages(snapshot) {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    const nodes = snapshot.docs.slice().reverse().map(doc => {
      const { nickname, body } = doc.data();
      const row = document.createElement('li');
      const author = document.createElement('strong');
      author.textContent = nickname;
      row.append(author, '  ', body);
      return row;
    });
    log.replaceChildren(...nodes);
    byId('chat-empty').hidden = nodes.length > 0;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function renderCooldown() {
    const seconds = Math.max(0, Math.ceil((cooldownUntil(lastRate) - Date.now()) / 1000));
    byId('chat-send-button').disabled = posting || seconds > 0;
    report('chat-cooldown', seconds ? '다음 전송까지 ' + seconds + '초' : '');
  }

  function renderOnline(players) {
    playersOnline = players;
    const visiblePlayers = showCompatibleOnly ? compatibleTradePeers(players, getTradeBuild(), auth.currentUser?.uid) : players;
    onlineButton.textContent = (showCompatibleOnly ? '같은 개조판 ' : '온라인 ') + visiblePlayers.length + '명';
    const emptyMessage = showCompatibleOnly ? '같은 개조판을 실행 중인 상대가 없습니다.' : '현재 접속자가 없습니다.';
    const selectable = showCompatibleOnly && tradeApi && tradeReady() && !flow && !pendingInvite();
    onlineList.replaceChildren(...(visiblePlayers.length ? visiblePlayers : [{ nickname: emptyMessage }]).map(player => {
      const item = document.createElement('li');
      if (selectable && player.uid) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = player.nickname;
        button.addEventListener('click', () => invitePlayer(player));
        item.append(button);
      } else item.textContent = player.nickname;
      return item;
    }));
    renderTrade();
  }

  function stopRoom() {
    unsubscribeRoom?.();
    unsubscribeRoom = undefined;
    presence?.stop();
    presence = undefined;
    stopInvites?.();
    stopInvites = undefined;
    if (flow) finishTrade(flow, '교환을 취소했습니다.');
    else releaseTradeHold();
    incoming = undefined;
    renderTrade();
  }

  function updateRoom() {
    room.hidden = !profile;
    onlineButton.hidden = !profile;
    if (!profile) {
      onlineList.hidden = true;
      onlineButton.setAttribute('aria-expanded', 'false');
      log.replaceChildren();
    }
    if (!profile || document.hidden) return stopRoom();
    if (unsubscribeRoom) return;
    const { uid } = auth.currentUser;
    const latest = data.query(messages, data.orderBy('seq', 'desc'), data.limit(100));
    const stopMessages = data.onSnapshot(latest, renderMessages, () => {
      setStatus('채팅을 불러오지 못했습니다. 연결을 확인하고 다시 로그인하세요.');
    });
    const stopRate = data.onSnapshot(data.doc(db, 'chatRate', uid), snapshot => {
      lastRate = snapshot.data();
      renderCooldown();
    }, () => {});
    const cooldownTimer = setInterval(renderCooldown, 1000);
    unsubscribeRoom = () => { stopMessages(); stopRate(); clearInterval(cooldownTimer); };
    presence = watchPresence({ db, data, uid, nickname: profile.nickname, getTradeBuild, onChange: renderOnline });
    watchInvites(uid);
  }

  async function sessionChanged() {
    const checking = ++session;
    const user = auth.currentUser;
    const eligible = Boolean(user && allowedEmail.test(user.email || ''));
    const verified = eligible && user.emailVerified;
    authButton.textContent = user ? '로그아웃' : '로그인';
    if (user) {
      authButton.removeAttribute('aria-haspopup');
      authButton.removeAttribute('aria-controls');
    } else {
      authButton.setAttribute('aria-haspopup', 'dialog');
      authButton.setAttribute('aria-controls', 'chat-auth-dialog');
    }
    openVerify.hidden = !eligible || verified;
    if (!user || verified) verifyDialog.close();
    profileForm.hidden = true;
    profile = undefined;
    lastRate = undefined;
    renderCooldown();
    updateRoom();
    if (!user) setStatus('채팅하려면 Gmail 또는 네이버 이메일로 로그인하세요.');
    else if (!eligible) setStatus('gmail.com 또는 naver.com 이메일로 로그인하세요.');
    else if (!verified) setStatus('메일 인증을 마치면 채팅에 입장할 수 있습니다.');
    else {
      setStatus('닉네임을 확인하는 중입니다.');
      try {
        const snap = await data.getDoc(data.doc(db, 'chatProfiles', user.uid));
        if (checking !== session) return;
        profile = snap.data();
        profileForm.hidden = Boolean(profile);
        updateRoom();
        setStatus(profile ? '' : '채팅에 표시할 닉네임을 등록하세요.');
      } catch {
        if (checking === session) setStatus('닉네임을 확인하지 못했습니다. 연결을 확인하고 다시 로그인하세요.');
      }
    }
  }

  async function accountAction(action, showError = setStatus) {
    if (authPending) return;
    authPending = true;
    try { await action(); }
    catch (error) {
      const messages = {
        'auth/invalid-credential': '이메일 또는 채팅 비밀번호를 확인하세요.',
        'auth/email-already-in-use': '이미 가입된 주소입니다. 로그인하거나 비밀번호를 재설정하세요.',
        'auth/weak-password': '채팅 비밀번호는 8자 이상으로 설정하세요.',
        'auth/too-many-requests': '요청이 많습니다. 잠시 뒤 다시 시도하세요.',
      };
      showError(messages[error.code] || '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.');
    } finally { authPending = false; }
  }

  login.addEventListener('submit', event => {
    event.preventDefault();
    const email = byId('chat-email').value.trim().toLowerCase();
    const password = byId('chat-password');
    const action = event.submitter?.value || 'sign-in';
    if (!allowedEmail.test(email)) return loginStatus('gmail.com 또는 naver.com 이메일을 입력하세요.');
    return accountAction(async () => {
      if (action === 'reset') {
        await account.sendPasswordResetEmail(auth, email);
        loginStatus('가입한 주소라면 비밀번호 재설정 메일이 도착합니다.');
      } else if (action === 'sign-up') {
        if (password.value.length < 8) return loginStatus('가입용 비밀번호를 8자 이상으로 설정하세요.');
        const credential = await account.createUserWithEmailAndPassword(auth, email, password.value);
        showVerification();
        verifyStatus('인증 메일을 보내는 중입니다.');
        try {
          await account.sendEmailVerification(credential.user);
          verifyStatus('인증 메일을 보냈습니다.');
        } catch {
          verifyStatus('메일을 보내지 못했습니다. 다시 보내기를 눌러 주세요.');
        }
      } else {
        const credential = await account.signInWithEmailAndPassword(auth, email, password.value);
        if (credential.user.emailVerified) loginDialog.close();
        else showVerification();
      }
    }, loginStatus);
  });

  function showVerification() {
    loginDialog.close();
    verifyStatus('');
    if (!verifyDialog.open) verifyDialog.showModal();
  }

  function checkVerification(silent = false) {
    return accountAction(async () => {
      const user = auth.currentUser;
      if (!user) return;
      await user.reload();
      if (!user.emailVerified) {
        if (!silent) verifyStatus('아직 인증되지 않았습니다. 받은 메일을 확인하세요.');
        return;
      }
      await user.getIdToken(true);
      await sessionChanged();
      if (profile) entry.focus();
      else if (!profileForm.hidden) nameField.focus();
    }, silent ? () => {} : verifyStatus);
  }

  loginDialog.addEventListener('close', () => {
    byId('chat-password').value = '';
    loginStatus('');
  });
  openVerify.addEventListener('click', showVerification);
  byId('chat-refresh').addEventListener('click', () => checkVerification());
  byId('chat-resend').addEventListener('click', () => accountAction(async () => {
    const user = auth.currentUser;
    if (!user) return;
    await account.sendEmailVerification(user);
    verifyStatus('인증 메일을 다시 보냈습니다.');
  }, verifyStatus));
  function setOnlineOpen(open) {
    onlineList.hidden = !open;
    onlineButton.setAttribute('aria-expanded', String(open));
  }

  onlineButton.addEventListener('click', () => {
    const open = onlineList.hidden;
    if (!open) {
      showCompatibleOnly = false;
      if (!flow) releaseTradeHold();
      renderOnline(playersOnline);
    }
    setOnlineOpen(open);
  });
  document.addEventListener('player-rom-build', () => {
    if (flow && flow.invite?.romHash !== getTradeBuild()) finishTrade(flow, '교환을 취소했습니다.');
    releaseTradeHold();
    showCompatibleOnly = false;
    renderOnline(playersOnline);
    presence?.refresh();
  });
  document.addEventListener('player-trade-wait', () => {
    if (screen.dataset.tradeReady !== 'true') {
      releaseTradeHold();
      if (flow && !flow.link) finishTrade(flow, '게임의 교환 대기가 끝났습니다.');
      showCompatibleOnly = false;
      renderOnline(playersOnline);
      return;
    }
    if (profile) {
      showCompatibleOnly = true;
      tradeNotice = '';
      holdForTrade();
      renderOnline(playersOnline);
      setOnlineOpen(true);
    }
    else setStatus('온라인 닉네임을 보려면 채팅 계정으로 로그인하고 닉네임을 등록하세요.');
    byId('chat').scrollIntoView({ block: 'nearest' });
  });
  tradeAccept.addEventListener('click', async () => {
    const invite = pendingInvite();
    const uid = auth.currentUser?.uid;
    if (!invite || !uid || !tradeReady() || flow || invite.romHash !== getTradeBuild()) return;
    const request = beginTrade(uid, invite.fromUid, false, '교환 요청을 수락하는 중…');
    request.invite = invite;
    try {
      request.invite = await tradeApi.acceptTradeInvite({ db, data, invite, romHash: getTradeBuild() });
      await connectTrade(request);
    } catch { finishTrade(request, '교환 요청을 수락하지 못했습니다.'); }
  });
  tradeCancel.addEventListener('click', async () => {
    if (flow) return finishTrade(flow, '교환을 취소했습니다.');
    const invite = pendingInvite();
    if (invite && auth.currentUser) {
      incoming = undefined;
      tradeNotice = '교환 요청을 거절했습니다.';
      renderOnline(playersOnline);
      await tradeApi.closeTradeInvite({ db, data, invite, uid: auth.currentUser.uid }).catch(() => {});
    } else {
      releaseTradeHold();
      showCompatibleOnly = false;
      renderOnline(playersOnline);
    }
  });

  profileForm.addEventListener('submit', event => {
    event.preventDefault();
    const user = auth.currentUser;
    const nickname = nicknameFor(nameField.value);
    if (!user?.emailVerified || !allowedEmail.test(user.email || '') || profile) return;
    if (!nickname) return setStatus('한글과 영문만 사용해 길이 기준에 맞춰 주세요.');
    if (!navigator.onLine) return setStatus('인터넷에 연결한 뒤 다시 등록하세요.');
    return accountAction(async () => {
      const nicknameKey = nickname.toLowerCase();
      const batch = data.writeBatch(db);
      batch.set(data.doc(db, 'chatProfiles', user.uid), { nickname, nicknameKey });
      batch.set(data.doc(db, 'chatNames', nicknameKey), { uid: user.uid });
      try {
        await batch.commit();
        nameField.value = '';
        await sessionChanged();
      } catch (error) {
        if (error.code !== 'permission-denied') return setStatus('등록에 실패했습니다. 잠시 뒤 다시 시도하세요.');
        await sessionChanged();
        if (!profile) setStatus('이미 쓰는 닉네임이거나 등록할 수 없는 이름입니다. 다른 이름을 입력하세요.');
      }
    });
  });

  send.addEventListener('submit', async event => {
    event.preventDefault();
    const user = auth.currentUser;
    const body = entry.value.trim();
    if (!profile || !user?.emailVerified || !allowedEmail.test(user.email || '') || !body || body.length > 240 || posting) return;
    if (cooldownUntil(lastRate) > Date.now()) return renderCooldown();
    if (!navigator.onLine) return setStatus('인터넷에 연결한 뒤 다시 보내세요.');
    posting = true;
    renderCooldown();
    try {
      const { nickname } = profile;
      const state = data.doc(db, 'chatState', 'current');
      const rate = data.doc(db, 'chatRate', user.uid);
      await data.runTransaction(db, async transaction => {
        const previous = await transaction.get(state);
        const lastPost = (await transaction.get(rate)).data();
        const seq = (previous.data()?.seq ?? 0) + 1;
        const messageId = messageSlot(seq);
        const createdAt = data.serverTimestamp();
        transaction.set(state, { seq });
        transaction.set(data.doc(messages, messageId), { uid: user.uid, nickname, body, createdAt, seq });
        transaction.set(rate, {
          messageId, createdAt, seq,
          previousAt: lastPost?.createdAt ?? null,
          firstOfThreeAt: lastPost?.previousAt ?? null,
        });
      });
      if (entry.value.trim() === body) entry.value = '';
      setStatus('');
    } catch (error) {
      setStatus(error.code === 'permission-denied' ? '전송 제한 또는 인증 상태를 확인하고 다시 보내세요.' : '메시지를 보내지 못했습니다. 다시 시도하세요.');
    } finally {
      posting = false;
      renderCooldown();
    }
  });

  account.onAuthStateChanged(auth, sessionChanged);
  document.addEventListener('visibilitychange', () => {
    updateRoom();
    if (!document.hidden && verifyDialog.open) checkVerification(true);
  });

  await auth.authStateReady();
  return () => {
    if (!auth.currentUser) {
      if (!loginDialog.open) loginDialog.showModal();
      return;
    }
    return accountAction(async () => {
      const lease = presence;
      stopRoom();
      if (lease && navigator.onLine) {
        await Promise.race([
          lease.removeOwnLease().catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 800)),
        ]);
      }
      await account.signOut(auth);
      entry.value = '';
      nameField.value = '';
    });
  };
}

if (firebaseConfig && typeof document !== 'undefined') {
  const authButton = byId('chat-auth');
  let connecting;
  function ensureChat() {
    connecting ??= connectChat(authButton).catch(() => {
      report('chat-status', '채팅에 연결하지 못했습니다. 온라인에서 로그인 버튼을 눌러 다시 시도하세요.');
      connecting = undefined;
    });
    return connecting;
  }
  byId('chat').hidden = false;
  authButton.hidden = false;
  authButton.addEventListener('click', async () => (await ensureChat())?.());
  ensureChat();
}
