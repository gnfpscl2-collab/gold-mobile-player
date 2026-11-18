const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('gold-mobile-player', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('files');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('기기 보관함을 열지 못했습니다. 세이브 파일로 따로 저장하세요.'));
});
database.catch(() => {});

export async function readLocal(key) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function writeLocal(key, value) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite');
    transaction.objectStore('files').put(value, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(new Error('기기 보관 공간이 부족합니다. 세이브 파일로 따로 저장하세요.'));
    transaction.onabort = () => reject(new Error('기기 보관을 완료하지 못했습니다. 세이브 파일로 따로 저장하세요.'));
  });
}

export async function writeLocalIfMissing(key, value) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite');
    const files = transaction.objectStore('files');
    const request = files.get(key);
    let selected;
    request.onsuccess = () => {
      selected = request.result;
      if (selected === undefined) {
        files.add(value, key);
        selected = value;
      }
    };
    transaction.oncomplete = () => resolve(selected);
    transaction.onabort = () => reject(new Error('기존 세이브를 새 개조판에 보관하지 못했습니다.'));
  });
}
