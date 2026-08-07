// Unit tests for the pure, browser-independent logic.
// Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkText, cosine } from '../rag.js';
import { nameToIso1, detectLang, TARGET_LANGS } from '../translate.js';

test('chunkText: empty input yields no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('chunkText: keeps small text as a single chunk', () => {
  const chunks = chunkText('Hello world.\n\nSecond paragraph.');
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /Second paragraph/);
});

test('chunkText: splits long text into multiple chunks', () => {
  const para = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} ` + 'lorem ipsum '.repeat(20)).join('\n\n');
  const chunks = chunkText(para, 400, 80);
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  for (const c of chunks) assert.ok(c.length <= 400 * 1.6 + 10, 'chunk within size bound');
});

test('cosine: identical vectors ~ 1, orthogonal ~ 0, opposite ~ -1', () => {
  const a = [1, 2, 3];
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-6);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-6);
  assert.ok(cosine([1, 0], [-1, 0]) < -0.99);
});

test('nameToIso1: maps target-language names to ISO 639-1', () => {
  assert.equal(nameToIso1('Português'), 'pt');
  assert.equal(nameToIso1('portugues'), 'pt');
  assert.equal(nameToIso1('English'), 'en');
  assert.equal(nameToIso1('Japonês'), 'ja');
});

test('TARGET_LANGS: non-empty and well-formed [name, iso1] pairs', () => {
  assert.ok(TARGET_LANGS.length >= 20);
  for (const [name, iso1] of TARGET_LANGS) {
    assert.equal(typeof name, 'string');
    assert.match(iso1, /^[a-z]{2}$/);
  }
});

test('detectLang: identifies Portuguese and English samples', () => {
  const pt = detectLang('Este é um documento em português com várias palavras para detecção.');
  assert.equal(pt.iso1, 'pt');
  const en = detectLang('This is a document written in the English language for detection.');
  assert.equal(en.iso1, 'en');
});
