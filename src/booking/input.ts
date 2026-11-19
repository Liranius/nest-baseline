import { BadRequestException } from '@nestjs/common';

export function invalidInput(): never {
  throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Invalid request parameters' });
}

export function objectInput(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalidInput();
  return value as Record<string, unknown>;
}

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
    invalidInput();
  return value.toLowerCase();
}

export function instant(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  )
    invalidInput();
  const day = value.slice(0, 10);
  const calendar = new Date(day + 'T00:00:00Z');
  const timestamp = new Date(value);
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== day ||
    !Number.isFinite(timestamp.getTime())
  )
    invalidInput();
  const iso = timestamp.toISOString();
  if (iso.length !== 24 || iso.startsWith('0000') || day.startsWith('0000')) invalidInput();
  return iso;
}

export function timeWindow(start: unknown, end: unknown) {
  const from = instant(start);
  const to = instant(end);
  if (from >= to) invalidInput();
  return { from, to };
}
