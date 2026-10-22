import { describe, expect, it } from 'vitest';
import { detectFormat, isBase64, isCodeLike, isIPv6 } from '../src/core/formats';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlJ1dHZpIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('detectFormat: positives', () => {
  it.each([
    ['2026-10-23T02:40:00Z', 'date-time'],
    ['2026-10-23T02:40:00.123+05:30', 'date-time'],
    ['2026-10-23 02:40:00', 'date-time'],
    ['2026-10-23T03:00', 'date-time'],
    ['2026-10-23', 'date'],
    ['14:30:00', 'time'],
    ['09:15', 'time'],
    ['rutvi@example.com', 'email'],
    ['first.last+tag@sub.example.co.in', 'email'],
    ['https://api.github.com/repos/nodejs/node', 'uri'],
    ['ftp://files.example.org/a.txt', 'uri'],
    ['550e8400-e29b-41d4-a716-446655440000', 'uuid'],
    ['192.168.1.20', 'ipv4'],
    ['2001:db8::8a2e:370:7334', 'ipv6'],
    ['::1', 'ipv6'],
    ['#ff8800', 'hex-color'],
    ['#fff', 'hex-color'],
    ['1.2.3', 'semver'],
    ['v18.2.0-beta.1', 'semver'],
    [JWT, 'jwt'],
    ['+1 (555) 123-4567', 'phone'],
    ['+919876543210', 'phone'],
    ['123.45', 'numeric-string'],
    ['-42', 'numeric-string'],
    ['007', 'numeric-string'],
    [BASE64, 'base64'],
    ['', 'empty'],
  ])('%s is %s', (input, expected) => {
    expect(detectFormat(input)).toBe(expected);
  });
});

describe('detectFormat: negatives stay plain', () => {
  it.each([
    'hello world',
    'active',
    'not-an-email@',
    '1.2.3.4.5',
    'deadbeef',
    'mailto:x@y.com',
    '24:61',
    'aGVsbG8=',
    'thisisaverylonglowercaseidentifierwithoutanydigitsatallreally',
    '12:30:45:99',
  ])('%s is plain', (input) => {
    expect(detectFormat(input)).toBe('plain');
  });
});

describe('format helpers', () => {
  it('validates IPv6 group counts and compression', () => {
    expect(isIPv6('1:2:3:4:5:6:7:8')).toBe(true);
    expect(isIPv6('1:2:3:4:5:6:7')).toBe(false);
    expect(isIPv6('1::2::3')).toBe(false);
    expect(isIPv6('g::1')).toBe(false);
  });

  it('requires long, mixed-case base64', () => {
    expect(isBase64(BASE64)).toBe(true);
    expect(isBase64('a94a8fe5ccb19ba61c4c0873d391e987982fbbd3a94a8fe5')).toBe(false); // hex, no uppercase
    expect(isBase64('short')).toBe(false);
  });

  it.each(['active', 'IN_PROGRESS', 'en-US', 'application/json', 'v2', 'card_declined'])('%s is code-like', (s) => {
    expect(isCodeLike(s)).toBe(true);
  });

  it.each(['hello world', '', 'x'.repeat(41), 'cus_N3x8aB2kQ', 'Ünïcode', 'a1b2c3d4e5'])('%s is not code-like', (s) => {
    expect(isCodeLike(s)).toBe(false);
  });
});
