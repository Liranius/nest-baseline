export function parsePort(value = '3000'): number {
  const port = Number(value);
  if (!/^[0-9]+$/.test(value) || port > 65535) {
    throw new Error('PORT must be a decimal integer from 0 to 65535.');
  }
  return port;
}
