import { parsePort } from './port.js';

describe('parsePort', () => {
  it('defaults to 3000 when PORT is unset', () => {
    expect(parsePort(undefined)).toBe(3000);
  });

  it.each([
    ['0', 0],
    ['003100', 3100],
    ['65535', 65535],
  ])('parses %s as TCP port %i', (value, expected) => {
    expect(parsePort(value)).toBe(expected);
  });

  it.each(['', ' 3100', '3100\n', '-1', '1.5', '1e3', '0xff', '65536', String.raw`\\.\pipe\nest`])(
    'rejects invalid PORT %j',
    (value) => {
      expect(() => parsePort(value)).toThrow('PORT must be a decimal integer from 0 to 65535');
    },
  );
});
