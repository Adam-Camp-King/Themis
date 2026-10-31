// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * The kernel ships no `node:` imports so it runs on Workers, Deno, Bun and in
 * the browser. These tests pin the replacement crypto to Node's own, and pin
 * the source tree to staying runtime-neutral.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  constantTimeHexEquals, fromBase64Url, hmacSha256Hex, sha256, toBase64Url, toHex, uuidV4,
} from '../src/internal/crypto.js';
import { DefaultDraftPolicy } from '../src/index.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function randomString(n: number): string {
  // Mix ASCII, 2-, 3- and 4-byte UTF-8 so padding and multi-byte encoding are both exercised.
  const pool = ['a', 'Z', '0', '.', ' ', 'é', 'ß', '€', '漢', '😀'];
  let s = '';
  for (let i = 0; i < n; i++) s += pool[randomBytes(1)[0]! % pool.length];
  return s;
}

test('sha256 matches node:crypto across block boundaries', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 4097]) {
    const data = new Uint8Array(randomBytes(len));
    assert.equal(toHex(sha256(data)), createHash('sha256').update(data).digest('hex'), `len ${len}`);
  }
});

test('sha256 matches the FIPS 180-4 "abc" vector', () => {
  assert.equal(
    toHex(sha256(new TextEncoder().encode('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('hmacSha256Hex matches node:crypto for random keys and messages (incl. keys longer than a block)', () => {
  for (let i = 0; i < 300; i++) {
    const key = randomString(1 + (randomBytes(1)[0]! % 90));
    const msg = randomString(randomBytes(1)[0]! * 2);
    assert.equal(hmacSha256Hex(key, msg), createHmac('sha256', key).update(msg, 'utf8').digest('hex'));
  }
});

test('base64url round-trips UTF-8 and matches Buffer encoding', () => {
  for (let i = 0; i < 200; i++) {
    const s = randomString(randomBytes(1)[0]! % 70);
    const enc = toBase64Url(s);
    assert.equal(enc, Buffer.from(s, 'utf8').toString('base64url'));
    assert.equal(fromBase64Url(enc), s);
  }
});

test('constantTimeHexEquals: equal, unequal, length and non-hex', () => {
  assert.equal(constantTimeHexEquals('ab01', 'ab01'), true);
  assert.equal(constantTimeHexEquals('AB01', 'ab01'), true);
  assert.equal(constantTimeHexEquals('ab01', 'ab02'), false);
  assert.equal(constantTimeHexEquals('ab01', 'ab0'), false);
  assert.equal(constantTimeHexEquals('zz01', 'zz01'), false);
});

test('preview tokens are byte-identical to the 0.2.1 node:crypto implementation', () => {
  const p = new DefaultDraftPolicy();
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const token = p.signPreviewToken('page-é', 7, 24, 's3cret');
    const exp = 1_700_000_000_000 + 24 * 3600_000;
    const payload = `v1.page-é.7.${exp}`;
    const mac = createHmac('sha256', 's3cret').update(payload, 'utf8').digest('hex');
    assert.equal(token, Buffer.from(`${payload}.${mac}`, 'utf8').toString('base64url'));
    assert.deepEqual(p.verifyPreviewToken(token, 's3cret'), { entity_id: 'page-é', tenant_id: 7 });
  } finally {
    Date.now = realNow;
  }
});

test('garbage tokens verify to null, never throw', () => {
  const p = new DefaultDraftPolicy();
  for (const t of ['', '!!!', '%%%%', 'a', 'djEu', '....']) assert.equal(p.verifyPreviewToken(t, 's'), null);
});

test('uuidV4 produces RFC 4122 v4 ids', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const id = uuidV4();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 100);
});

test('the kernel source imports nothing from node: and never touches Buffer', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  for (const file of walk(SRC)) {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    assert.doesNotMatch(code, /from ['"]node:/, `${file} imports a node: module`);
    assert.doesNotMatch(code, /\bBuffer\./, `${file} uses Buffer`);
  }
});
