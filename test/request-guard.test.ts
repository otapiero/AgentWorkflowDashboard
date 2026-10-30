import { describe, expect, test } from 'vitest';

import { rejectReason } from '../src/server/request-guard.ts';

/**
 * The server can launch agents with any prompt, so a page on another site
 * must not be able to reach it through the browser.
 */
describe('request guard', () => {
  test('admits the board itself and clients that send no Origin', () => {
    expect(rejectReason('127.0.0.1:4317', 'http://127.0.0.1:4317')).toBeNull();
    expect(rejectReason('localhost:4316', 'http://localhost:4316')).toBeNull();
    expect(rejectReason('127.0.0.1:4317', undefined)).toBeNull();
  });

  test('refuses a rebound domain that resolves to this machine', () => {
    expect(rejectReason('attacker.example:4317', undefined)).not.toBeNull();
    expect(rejectReason('attacker.example:4317', 'http://attacker.example:4317')).not.toBeNull();
    expect(rejectReason('attacker.example@127.0.0.1:4317', undefined)).not.toBeNull();
    expect(rejectReason(undefined, undefined)).not.toBeNull();
  });

  test('refuses requests a page on another origin sends', () => {
    expect(rejectReason('127.0.0.1:4317', 'https://attacker.example')).not.toBeNull();
    // Another local web app is still another origin.
    expect(rejectReason('127.0.0.1:4317', 'http://localhost:3000')).not.toBeNull();
    expect(rejectReason('127.0.0.1:4317', 'http://127.0.0.1:3000')).not.toBeNull();
    // Sandboxed frames and file:// pages send a literal "null".
    expect(rejectReason('127.0.0.1:4317', 'null')).not.toBeNull();
  });
});
