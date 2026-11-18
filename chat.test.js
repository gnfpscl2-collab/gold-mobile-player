import test from 'node:test';
import assert from 'node:assert/strict';
import { cooldownUntil, messageSlot, nicknameFor } from './chat.js';

test('nicknames count Hangul as two characters and normalize composed input', () => {
  assert.equal(nicknameFor('가나다라마바사'), null);
  assert.equal(nicknameFor('가나다라마바'), '가나다라마바');
  assert.equal(nicknameFor('AbCdEfGhIjKl'), 'AbCdEfGhIjKl');
  assert.equal(nicknameFor('AbCdEfGhIjKlM'), null);
  assert.equal(nicknameFor('가나다abcdef'), '가나다abcdef');
  assert.equal(nicknameFor('가나다abcdefg'), null);
  assert.equal(nicknameFor('가나'), '가나');
  for (const invalid of ['', 'Gold Player', 'name1', 'ᄀ', 'a/b', 'Pokémon', '골드😀']) {
    assert.equal(nicknameFor(invalid), null);
  }
});

test('new message slots displace the oldest messages after 100', () => {
  const stored = new Map();
  for (let seq = 1; seq <= 201; seq++) stored.set(messageSlot(seq), seq);
  assert.equal(stored.size, 100);
  assert.equal(stored.get('m1'), 201);
  assert.deepEqual([...stored.values()].sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 102));
});

test('three accepted messages in ten seconds impose a fifteen-second cooldown', () => {
  const stamp = time => ({ toMillis: () => time });
  assert.equal(cooldownUntil(undefined), 0);
  assert.equal(cooldownUntil({ createdAt: stamp(10_000) }), 13_000);
  assert.equal(cooldownUntil({ createdAt: stamp(10_000), firstOfThreeAt: stamp(0) }), 25_000);
  assert.equal(cooldownUntil({ createdAt: stamp(10_001), firstOfThreeAt: stamp(0) }), 13_001);
  assert.equal(cooldownUntil({ createdAt: stamp(25_000), firstOfThreeAt: stamp(5_000) }), 28_000);
});
