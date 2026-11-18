# 채팅 연결

1. [Firebase 콘솔](https://console.firebase.google.com/)에서 채팅 전용 프로젝트를 만듭니다. 요금제는 Spark, Google 애널리틱스는 끔으로 선택합니다. Firebase 약관에 처음 동의해야 하는 경우 프로젝트 소유자가 진행합니다.
2. Authentication을 시작하고 **Sign-in method → Email/Password**를 켭니다. Gmail과 네이버 메일 모두 이메일과 이 사이트에서 정한 채팅용 비밀번호를 사용합니다. 가입 후 인증 메일을 확인해야 채팅에 입장할 수 있습니다. **Settings → Authorized domains**에 `gnfpscl2-collab.github.io`를 추가합니다.
3. Firestore Database에서 기본 데이터베이스를 만들고 **프로덕션 모드**를 선택합니다. Rules 탭에 [firestore.rules](./firestore.rules)를 붙여 넣어 게시합니다. Firebase CLI가 이미 있다면 이 폴더에서 `firebase deploy --only firestore:rules --project PROJECT_ID`로 게시할 수 있습니다.
4. 프로젝트 설정에서 웹 앱을 등록합니다. SDK 설정에 나오는 공개 웹 설정 객체를 [chat-config.js](./chat-config.js)의 `firebaseConfig`에 넣고 GitHub Pages에 반영합니다. 콘솔의 관리자 키와 서비스 계정 파일은 별도 보관합니다.
5. 배포 전에 인증된 Gmail과 네이버 메일 계정으로 각각 입장과 전송을 확인합니다. 로그아웃 상태, 미인증 계정, 그 외 도메인은 서버가 읽기와 쓰기를 거부해야 합니다. 메시지는 240자까지 보낼 수 있고 같은 계정은 전송 사이에 3초가 필요합니다.

채팅에는 메시지 본문, 작성 시각, 계정 식별자만 기록합니다. 최근 메시지 40개까지 불러옵니다. 이메일 주소는 Firebase Authentication에서 확인합니다. 게임과 세이브는 기존 브라우저 보관 방식을 사용합니다.
