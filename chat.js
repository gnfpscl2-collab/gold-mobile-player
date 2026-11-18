import { firebaseConfig } from './chat-config.js?v=1.5.0';

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

async function connectChat(chat) {
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
  const profileForm = byId('chat-profile');
  const nameField = byId('chat-nickname');
  const refresh = byId('chat-refresh');
  const resend = byId('chat-resend');
  const logout = byId('chat-logout');
  const room = byId('chat-room');
  const log = byId('chat-messages');
  const entry = byId('chat-message');
  const send = byId('chat-send');
  const setStatus = message => { byId('chat-status').textContent = message; };
  let unsubscribe;
  let authPending = false;
  let posting = false;
  let profile;
  let session = 0;

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
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function updateRoom() {
    room.hidden = !profile;
    if (!profile || !chat.open) {
      unsubscribe?.();
      unsubscribe = undefined;
      log.replaceChildren();
    } else if (!unsubscribe) {
      const latest = data.query(messages, data.orderBy('seq', 'desc'), data.limit(100));
      unsubscribe = data.onSnapshot(latest, renderMessages, () => {
        setStatus('채팅을 불러오지 못했습니다. 연결을 확인하고 채팅을 다시 열어 주세요.');
      });
    }
  }

  async function sessionChanged() {
    const checking = ++session;
    const user = auth.currentUser;
    const eligible = Boolean(user && allowedEmail.test(user.email || ''));
    const verified = eligible && user.emailVerified;
    login.hidden = Boolean(user);
    byId('chat-account').hidden = !user;
    refresh.hidden = !eligible || verified;
    resend.hidden = refresh.hidden;
    profileForm.hidden = true;
    profile = undefined;
    updateRoom();
    if (!user) setStatus('Gmail·네이버 이메일을 인증한 뒤 채팅할 수 있습니다.');
    else if (!eligible) setStatus('gmail.com 또는 naver.com 이메일로 로그인하세요.');
    else if (!verified) setStatus('인증 메일의 링크를 누른 뒤 여기서 인증 확인을 누르세요.');
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

  async function accountAction(action) {
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
      setStatus(messages[error.code] || '로그인 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.');
    } finally { authPending = false; }
  }

  login.addEventListener('submit', event => {
    event.preventDefault();
    const email = byId('chat-email').value.trim().toLowerCase();
    const password = byId('chat-password');
    const action = event.submitter?.value || 'sign-in';
    if (!allowedEmail.test(email)) return setStatus('gmail.com 또는 naver.com 이메일을 입력하세요.');
    return accountAction(async () => {
      if (action === 'reset') {
        await account.sendPasswordResetEmail(auth, email);
        setStatus('가입한 주소라면 비밀번호 재설정 메일이 도착합니다.');
      } else if (action === 'sign-up') {
        if (password.value.length < 8) return setStatus('가입용 비밀번호를 8자 이상으로 설정하세요.');
        const credential = await account.createUserWithEmailAndPassword(auth, email, password.value);
        password.value = '';
        await account.sendEmailVerification(credential.user);
        setStatus('인증 메일의 링크를 누른 뒤 여기서 인증 확인을 누르세요.');
      } else {
        await account.signInWithEmailAndPassword(auth, email, password.value);
        password.value = '';
      }
    });
  });
  refresh.addEventListener('click', () => accountAction(async () => {
    const user = auth.currentUser;
    if (!user) return;
    await user.reload();
    await user.getIdToken(true);
    sessionChanged();
  }));
  resend.addEventListener('click', () => accountAction(async () => {
    if (!auth.currentUser) return;
    await account.sendEmailVerification(auth.currentUser);
    setStatus('인증 메일을 다시 보냈습니다.');
  }));
  logout.addEventListener('click', () => accountAction(async () => {
    await account.signOut(auth);
    entry.value = '';
    byId('chat-password').value = '';
  }));

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
    if (!navigator.onLine) return setStatus('인터넷에 연결한 뒤 다시 보내세요.');
    posting = true;
    try {
      const { nickname } = profile;
      const state = data.doc(db, 'chatState', 'current');
      const rate = data.doc(db, 'chatRate', user.uid);
      await data.runTransaction(db, async transaction => {
        const previous = await transaction.get(state);
        const seq = (previous.data()?.seq ?? 0) + 1;
        const messageId = messageSlot(seq);
        const createdAt = data.serverTimestamp();
        transaction.set(state, { seq });
        transaction.set(data.doc(messages, messageId), { uid: user.uid, nickname, body, createdAt, seq });
        transaction.set(rate, { messageId, createdAt, seq });
      });
      if (entry.value.trim() === body) entry.value = '';
      setStatus('');
    } catch (error) {
      setStatus(error.code === 'permission-denied' ? '인증 상태를 확인하고 3초 뒤 다시 보내세요.' : '메시지를 보내지 못했습니다. 다시 시도하세요.');
    } finally { posting = false; }
  });

  account.onAuthStateChanged(auth, sessionChanged);
  chat.addEventListener('toggle', updateRoom);
}

if (firebaseConfig && typeof document !== 'undefined') {
  const chat = byId('chat');
  let connecting;
  chat.hidden = false;
  chat.addEventListener('toggle', () => {
    if (!chat.open || connecting) return;
    connecting = connectChat(chat).catch(() => {
      byId('chat-status').textContent = '채팅에 연결하지 못했습니다. 닫았다가 다시 열어 주세요.';
      connecting = undefined;
    });
  });
}
