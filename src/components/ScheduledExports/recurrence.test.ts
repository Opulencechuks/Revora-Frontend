import { describe, it, expect } from 'vitest';
import {
  describeSchedule,
  formatTime,
  computeNextRun,
  validateRecurrenceRule,
  validateScheduleForm,
  defaultRecurrenceRule,
} from './recurrence';
import type { RecurrenceRule } from './types';

describe('formatTime', () => {
  it('formats midnight as 12:00 AM', () => {
    expect(formatTime('00:00')).toBe('12:00 AM');
  });

  it('formats noon as 12:00 PM', () => {
    expect(formatTime('12:00')).toBe('12:00 PM');
  });

  it('formats morning hours correctly', () => {
    expect(formatTime('09:15')).toBe('9:15 AM');
  });

  it('formats afternoon hours correctly', () => {
    expect(formatTime('14:30')).toBe('2:30 PM');
  });

  it('pads minutes to two digits', () => {
    expect(formatTime('07:05')).toBe('7:05 AM');
  });

  it('returns the input unchanged for non-standard format', () => {
    expect(formatTime('invalid')).toBe('invalid');
  });
});

describe('describeSchedule', () => {
  it('describes a daily schedule', () => {
    const rule: RecurrenceRule = { frequency: 'daily', time: '09:00', timezone: 'UTC' };
    expect(describeSchedule(rule)).toBe('Daily at 9:00 AM (UTC)');
  });

  it('describes a weekly schedule', () => {
    const rule: RecurrenceRule = { frequency: 'weekly', time: '14:00', timezone: 'America/New_York', dayOfWeek: 1 };
    expect(describeSchedule(rule)).toBe('Weekly on Monday at 2:00 PM (America/New_York)');
  });

  it('describes a monthly schedule with ordinal suffix', () => {
    const rule: RecurrenceRule = { frequency: 'monthly', time: '02:00', timezone: 'UTC', dayOfMonth: 1 };
    expect(describeSchedule(rule)).toBe('Monthly on the 1st at 2:00 AM (UTC)');
  });

  it('uses ordinal suffix 2nd for day 2', () => {
    const rule: RecurrenceRule = { frequency: 'monthly', time: '02:00', timezone: 'UTC', dayOfMonth: 2 };
    expect(describeSchedule(rule)).toContain('2nd');
  });

  it('uses ordinal suffix 3rd for day 3', () => {
    const rule: RecurrenceRule = { frequency: 'monthly', time: '02:00', timezone: 'UTC', dayOfMonth: 3 };
    expect(describeSchedule(rule)).toContain('3rd');
  });

  it('uses ordinal suffix th for day 11-13', () => {
    expect(describeSchedule({ frequency: 'monthly', time: '02:00', timezone: 'UTC', dayOfMonth: 11 })).toContain('11th');
    expect(describeSchedule({ frequency: 'monthly', time: '02:00', timezone: 'UTC', dayOfMonth: 12 })).toContain('12th');
    expect(describeSchedule({ frequency: 'monthly', time: '02:00', timezone: 'UTC', dayOfMonth: 13 })).toContain('13th');
  });

  it('falls back to Monday for weekly when dayOfWeek is undefined', () => {
    const rule: RecurrenceRule = { frequency: 'weekly', time: '10:00', timezone: 'UTC' };
    expect(describeSchedule(rule)).toBe('Weekly on Monday at 10:00 AM (UTC)');
  });

  it('falls back to day 1 for monthly when dayOfMonth is undefined', () => {
    const rule: RecurrenceRule = { frequency: 'monthly', time: '10:00', timezone: 'UTC' };
    expect(describeSchedule(rule)).toContain('1st');
  });
});

describe('computeNextRun', () => {
  it('returns the same-day run if the time has not passed yet (daily)', () => {
    const base = new Date('2026-07-28T12:00:00Z');
    const rule: RecurrenceRule = { frequency: 'daily', time: '14:00', timezone: 'UTC' };
    const result = computeNextRun(rule, base);
    expect(new Date(result).toISOString()).toBe('2026-07-28T14:00:00.000Z');
  });

  it('returns the next day for daily when the time has passed', () => {
    const base = new Date('2026-07-28T12:00:00Z');
    const rule: RecurrenceRule = { frequency: 'daily', time: '08:00', timezone: 'UTC' };
    const result = computeNextRun(rule, base);
    expect(new Date(result).toISOString()).toBe('2026-07-29T08:00:00.000Z');
  });

  it('computes next weekly run on Monday when today is Tuesday', () => {
    const base = new Date('2026-07-28T12:00:00Z');
    const rule: RecurrenceRule = { frequency: 'weekly', time: '10:00', timezone: 'UTC', dayOfWeek: 1 };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCHours()).toBe(10);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('computes next monthly run on the correct day', () => {
    const base = new Date('2026-07-28T12:00:00Z');
    const rule: RecurrenceRule = { frequency: 'monthly', time: '02:00', timezone: 'UTC', dayOfMonth: 1 };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCMonth()).toBe(7);
  });

  it('handles daily schedule across timezone boundaries', () => {
    const rule: RecurrenceRule = { frequency: 'daily', time: '09:00', timezone: 'America/New_York' };
    const base = new Date('2026-11-01T12:00:00Z');
    const result = computeNextRun(rule, base);
    const next = new Date(result);
    expect(next.getTime()).toBeGreaterThan(base.getTime());
    expect(next.getUTCDate()).toBeGreaterThanOrEqual(1);
  });

  /* ── DST transition tests ───────────────────────────────────────────── */

  it('handles "spring forward" DST transition (daily)', () => {
    // US spring-forward: Mar 8, 2026 at 02:00 EST → 03:00 EDT
    // Schedule: daily at 02:30 America/New_York
    // The function computes using the EST offset (UTC-5) before the
    // transition, returning 02:30 EST = 07:30 UTC. Advanced DST-gap
    // detection would skip to the next valid time after the transition.
    // The assertion below verifies the current (gap-aware limited) behaviour.
    const base = new Date('2026-03-08T06:00:00Z'); // 01:00 EST
    const rule: RecurrenceRule = {
      frequency: 'daily',
      time: '02:30',
      timezone: 'America/New_York',
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    // Pre-transition 02:30 EST = 07:30 UTC on Mar 8
    expect(d.getUTCMonth()).toBe(2); // March
    expect(d.getUTCHours()).toBe(7);
    expect(d.getUTCMinutes()).toBe(30);
    expect(d.getTime()).toBeGreaterThan(base.getTime());
  });

  it('handles "fall back" DST transition (daily)', () => {
    // US fall-back: Nov 1, 2026 at 02:00 EDT → 01:00 EST
    // Schedule: daily at 01:30 America/New_York
    // On Nov 1, 01:30 occurs twice (once in EDT, once in EST).
    // The function should compute the next valid time correctly.
    const base = new Date('2026-11-01T05:00:00Z'); // 01:00 EDT
    const rule: RecurrenceRule = {
      frequency: 'daily',
      time: '01:30',
      timezone: 'America/New_York',
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    // Next run: Nov 1 at 01:30 EST (after fall-back) = 06:30 UTC
    // Since the first 01:30 (EDT = 05:30 UTC) has passed
    expect(d.getTime()).toBeGreaterThan(base.getTime());
    expect(d.getUTCMonth()).toBe(10); // November
    expect(d.getUTCDate()).toBe(1);
  });

  /* ── Monthly edge cases ──────────────────────────────────────────────── */

  it('snaps to correct day within the same month for monthly on 31st', () => {
    // Schedule: monthly on 31st at 02:00 UTC
    // Starting from Jan 15, the next run should be Jan 31 (same month)
    const base = new Date('2026-01-15T12:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      time: '02:00',
      timezone: 'UTC',
      dayOfMonth: 31,
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    // Jan 31 exists, so next is Jan 31 at 02:00 UTC
    expect(d.getUTCMonth()).toBe(0); // January
    expect(d.getUTCDate()).toBe(31);
  });

  it('clamps day-of-month when advancing from January 31 to February', () => {
    // Schedule: monthly on 31st at 02:00 UTC
    // Starting from Jan 31 12:00 UTC, the Jan 31 02:00 has already passed
    // Next should be Feb 28 (clamped) at 02:00 UTC
    const base = new Date('2026-01-31T12:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      time: '02:00',
      timezone: 'UTC',
      dayOfMonth: 31,
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    // Feb 2026 has 28 days, so 31 is clamped to 28
    expect(d.getUTCMonth()).toBe(1); // February
    expect(d.getUTCDate()).toBe(28);
    expect(d.getUTCHours()).toBe(2);
  });

  it('handles monthly schedule when current date === dayOfMonth and time has passed', () => {
    // Schedule: monthly on 15th at 02:00 UTC
    // Current: 15th at 12:00 UTC (time has passed)
    // Next should be next month on the 15th
    const base = new Date('2026-03-15T12:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      time: '02:00',
      timezone: 'UTC',
      dayOfMonth: 15,
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    expect(d.getUTCMonth()).toBe(3); // April
    expect(d.getUTCDate()).toBe(15);
  });

  /* ── Weekly edge cases ───────────────────────────────────────────────── */

  it('handles weekly schedule when today matches target day and time is in future', () => {
    // Schedule: weekly on Tuesday at 14:00 UTC
    // Current: Tuesday at 12:00 UTC (time hasn't passed)
    // Next should be today at 14:00 UTC
    const base = new Date('2026-07-28T12:00:00Z'); // Tuesday
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      time: '14:00',
      timezone: 'UTC',
      dayOfWeek: 2, // Tuesday
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    expect(d.getUTCDay()).toBe(2); // Tuesday
    expect(d.getUTCHours()).toBe(14);
    expect(d.getUTCMinutes()).toBe(0);
    // Should be today (same UTC date)
    expect(d.getUTCDate()).toBe(28);
    expect(d.getUTCMonth()).toBe(6); // July
  });

  it('handles weekly schedule when today matches target day and time has passed', () => {
    // Schedule: weekly on Tuesday at 08:00 UTC
    // Current: Tuesday at 12:00 UTC (time has passed)
    // Next should be next Tuesday at 08:00 UTC
    const base = new Date('2026-07-28T12:00:00Z'); // Tuesday
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      time: '08:00',
      timezone: 'UTC',
      dayOfWeek: 2, // Tuesday
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    expect(d.getUTCDay()).toBe(2); // Tuesday
    expect(d.getUTCHours()).toBe(8);
    // Should be next Tuesday (Aug 4)
    expect(d.getUTCDate()).toBe(4);
    expect(d.getUTCMonth()).toBe(7); // August
  });

  /* ── Non-UTC timezone edge cases ─────────────────────────────────────── */

  it('handles daily schedule in America/New_York with time later today', () => {
    // Current UTC: 2026-07-28T15:00:00Z = 11:00 EDT
    // Schedule: daily at 14:00 America/New_York (18:00 UTC)
    // Time hasn't passed yet, so next run should be today at 18:00 UTC
    const base = new Date('2026-07-28T15:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'daily',
      time: '14:00',
      timezone: 'America/New_York',
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    expect(d.toISOString()).toBe('2026-07-28T18:00:00.000Z');
  });

  it('handles daily schedule in Asia/Tokyo across date boundary', () => {
    // Current UTC: 2026-07-28T15:00:00Z = July 29 00:00 JST
    // Schedule: daily at 01:00 Asia/Tokyo
    // In JST, current time is just past midnight (00:00).
    // Next run is today (July 29 JST) at 01:00 JST = July 28 16:00 UTC
    const base = new Date('2026-07-28T15:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'daily',
      time: '01:00',
      timezone: 'Asia/Tokyo',
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    // July 29 01:00 JST = July 28 16:00 UTC
    expect(d.getUTCHours()).toBe(16);
    expect(d.getUTCDate()).toBe(28);
  });

  it('advances daily schedule across year boundary', () => {
    // Schedule: daily at 09:00 UTC
    // Current: Dec 31 2026 at 23:00 UTC
    // Next run: Jan 1 2027 at 09:00 UTC
    const base = new Date('2026-12-31T23:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'daily',
      time: '09:00',
      timezone: 'UTC',
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    expect(d.getUTCFullYear()).toBe(2027);
    expect(d.getUTCMonth()).toBe(0); // January
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(9);
  });

  /* ── Non-UTC timezone monthly (timezone offset preservation) ────────── */

  it('preserves timezone offset when snapping monthly in America/New_York', () => {
    // Rule: monthly on 15th at 10:00 America/New_York
    // Now: Jan 10 at 09:00 EST (14:00 UTC) — time hasn't passed yet
    // Next run should be Jan 15 at 10:00 EST = 15:00 UTC
    const base = new Date('2026-01-10T14:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      time: '10:00',
      timezone: 'America/New_York',
      dayOfMonth: 15,
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    // Jan 15 at 10:00 EST = 15:00 UTC
    expect(d.getUTCMonth()).toBe(0); // January
    expect(d.getUTCDate()).toBe(15);
    expect(d.getUTCHours()).toBe(15);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('preserves timezone offset when advancing monthly in America/New_York', () => {
    // Rule: monthly on 15th at 10:00 America/New_York
    // Now: Feb 14 at 11:00 EST = 16:00 UTC (Feb 15 10:00 EST is in the past!
    // Wait, Feb 15 10:00 EST = 15:00 UTC, and now is Feb 14 16:00 UTC, so Feb 15 hasn't passed yet)
    // Let's use now = Feb 15 at 14:00 UTC = 09:00 EST — Feb 15 at 10:00 EST hasn't passed yet
    // Actually let's be precise: Feb 15 at 10:00 EST = Feb 15 at 15:00 UTC
    // If now = Feb 15 at 16:00 UTC (11:00 EST), then 10:00 EST has passed.
    const base = new Date('2026-02-15T16:00:00Z'); // 11:00 EST — 10:00 EST has passed
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      time: '10:00',
      timezone: 'America/New_York',
      dayOfMonth: 15,
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    // Next run: Mar 15 at 10:00 EDT (daylight time, UTC-4) = 14:00 UTC
    expect(d.getUTCMonth()).toBe(2); // March (EDT now)
    expect(d.getUTCDate()).toBe(15);
    expect(d.getUTCHours()).toBe(14); // 10:00 EDT = 14:00 UTC
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('preserves timezone offset for monthly in Asia/Tokyo', () => {
    // Rule: monthly on 5th at 09:00 Asia/Tokyo (UTC+9)
    // Now: Mar 14 at 20:00 UTC = Mar 15 at 05:00 JST
    // Mar 5 at 09:00 JST = Mar 5 at 00:00 UTC — already passed
    // Next run: Apr 5 at 09:00 JST = Apr 5 at 00:00 UTC
    const base = new Date('2026-03-14T20:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      time: '09:00',
      timezone: 'Asia/Tokyo',
      dayOfMonth: 5,
    };
    const result = computeNextRun(rule, base);
    const d = new Date(result);
    // Apr 5 at 09:00 JST = Apr 5 at 00:00 UTC
    expect(d.getUTCMonth()).toBe(3); // April
    expect(d.getUTCDate()).toBe(5);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
  });

  /* ── Non-UTC weekly/monthly snapping & DST wall-clock preservation ──── */

  const WEEKDAY_MAP: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  function getLocalParts(isoString: string, timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(isoString));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return {
      year: parseInt(get('year'), 10),
      month: parseInt(get('month'), 10),
      day: parseInt(get('day'), 10),
      weekday: WEEKDAY_MAP[get('weekday')],
      hour: parseInt(get('hour'), 10),
      minute: parseInt(get('minute'), 10),
    };
  }

  it('snaps weekly schedule to local weekday in Pacific/Auckland (UTC+13) near midnight', () => {
    // 2026-01-11T11:30:00Z = Monday Jan 12, 2026 00:30 NZDT (UTC+13)
    const base = new Date('2026-01-11T11:30:00Z');
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      time: '01:00',
      timezone: 'Pacific/Auckland',
      dayOfWeek: 1, // Monday
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-01-11T12:00:00.000Z');
    expect(getLocalParts(result, 'Pacific/Auckland')).toEqual({
      year: 2026,
      month: 1,
      day: 12,
      weekday: 1,
      hour: 1,
      minute: 0,
    });
  });

  it('advances weekly schedule by 7 local days in Pacific/Auckland (UTC+13) when time passed', () => {
    // 2026-01-11T12:30:00Z = Monday Jan 12, 2026 01:30 NZDT (UTC+13)
    const base = new Date('2026-01-11T12:30:00Z');
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      time: '01:00',
      timezone: 'Pacific/Auckland',
      dayOfWeek: 1, // Monday
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-01-18T12:00:00.000Z');
    expect(getLocalParts(result, 'Pacific/Auckland')).toEqual({
      year: 2026,
      month: 1,
      day: 19,
      weekday: 1,
      hour: 1,
      minute: 0,
    });
  });

  it('snaps weekly schedule to local weekday in America/Los_Angeles (UTC-8) near midnight', () => {
    // 2026-01-13T05:30:00Z = Monday Jan 12, 2026 21:30 PST (UTC-8)
    const base = new Date('2026-01-13T05:30:00Z');
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      time: '22:00',
      timezone: 'America/Los_Angeles',
      dayOfWeek: 1, // Monday
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-01-13T06:00:00.000Z');
    expect(getLocalParts(result, 'America/Los_Angeles')).toEqual({
      year: 2026,
      month: 1,
      day: 12,
      weekday: 1,
      hour: 22,
      minute: 0,
    });
  });

  it('advances weekly schedule by 7 local days in America/Los_Angeles (UTC-8) when time passed', () => {
    // 2026-01-13T06:30:00Z = Monday Jan 12, 2026 22:30 PST (UTC-8)
    const base = new Date('2026-01-13T06:30:00Z');
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      time: '22:00',
      timezone: 'America/Los_Angeles',
      dayOfWeek: 1, // Monday
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-01-20T06:00:00.000Z');
    expect(getLocalParts(result, 'America/Los_Angeles')).toEqual({
      year: 2026,
      month: 1,
      day: 19,
      weekday: 1,
      hour: 22,
      minute: 0,
    });
  });

  it('snaps monthly schedule in Pacific/Auckland (UTC+13) when local month is ahead of UTC', () => {
    // 2026-02-28T11:30:00Z = March 1, 2026 00:30 NZDT (UTC+13)
    const base = new Date('2026-02-28T11:30:00Z');
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      time: '01:00',
      timezone: 'Pacific/Auckland',
      dayOfMonth: 1,
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-02-28T12:00:00.000Z');
    expect(getLocalParts(result, 'Pacific/Auckland')).toEqual({
      year: 2026,
      month: 3,
      day: 1,
      weekday: 0,
      hour: 1,
      minute: 0,
    });
  });

  it('clamps monthly 31st to Feb 28 in Pacific/Auckland (UTC+13) near midnight', () => {
    // 2026-01-30T12:30:00Z = Jan 31, 2026 01:30 NZDT (UTC+13)
    const base = new Date('2026-01-30T12:30:00Z');
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      time: '01:00',
      timezone: 'Pacific/Auckland',
      dayOfMonth: 31,
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-02-27T12:00:00.000Z');
    expect(getLocalParts(result, 'Pacific/Auckland')).toEqual({
      year: 2026,
      month: 2,
      day: 28,
      weekday: 6,
      hour: 1,
      minute: 0,
    });
  });

  it('clamps monthly 31st to Feb 28 in America/Los_Angeles (UTC-8) near midnight', () => {
    // 2026-02-01T06:30:00Z = Jan 31, 2026 22:30 PST (UTC-8)
    const base = new Date('2026-02-01T06:30:00Z');
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      time: '22:00',
      timezone: 'America/Los_Angeles',
      dayOfMonth: 31,
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-03-01T06:00:00.000Z');
    expect(getLocalParts(result, 'America/Los_Angeles')).toEqual({
      year: 2026,
      month: 2,
      day: 28,
      weekday: 6,
      hour: 22,
      minute: 0,
    });
  });

  it('keeps wall-clock time for daily schedule across spring-forward DST', () => {
    // Mar 7 2026 10:00 EST -> next run Mar 8 2026 09:00 EDT (UTC-4 = 13:00Z)
    const base = new Date('2026-03-07T15:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'daily',
      time: '09:00',
      timezone: 'America/New_York',
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-03-08T13:00:00.000Z');
    expect(getLocalParts(result, 'America/New_York')).toMatchObject({
      year: 2026,
      month: 3,
      day: 8,
      hour: 9,
      minute: 0,
    });
  });

  it('keeps wall-clock time for daily schedule across fall-back DST', () => {
    // Oct 31 2026 10:00 EDT -> next run Nov 1 2026 09:00 EST (UTC-5 = 14:00Z)
    const base = new Date('2026-10-31T14:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'daily',
      time: '09:00',
      timezone: 'America/New_York',
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-11-01T14:00:00.000Z');
    expect(getLocalParts(result, 'America/New_York')).toMatchObject({
      year: 2026,
      month: 11,
      day: 1,
      hour: 9,
      minute: 0,
    });
  });

  it('keeps wall-clock time for weekly schedule across spring-forward DST', () => {
    // Mon Mar 2 2026 10:00 PST -> next run Mon Mar 9 2026 09:00 PDT (UTC-7 = 16:00Z)
    const base = new Date('2026-03-02T18:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      time: '09:00',
      timezone: 'America/Los_Angeles',
      dayOfWeek: 1,
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-03-09T16:00:00.000Z');
    expect(getLocalParts(result, 'America/Los_Angeles')).toMatchObject({
      year: 2026,
      month: 3,
      day: 9,
      weekday: 1,
      hour: 9,
      minute: 0,
    });
  });

  it('keeps wall-clock time for weekly schedule across southern-hemisphere fall-back DST', () => {
    // Mon Mar 30 2026 13:00 NZDT -> NZ DST ends Apr 5 -> Mon Apr 6 2026 09:00 NZST (UTC+12 = Apr 5 21:00Z)
    const base = new Date('2026-03-30T00:00:00Z');
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      time: '09:00',
      timezone: 'Pacific/Auckland',
      dayOfWeek: 1,
    };
    const result = computeNextRun(rule, base);
    expect(result).toBe('2026-04-05T21:00:00.000Z');
    expect(getLocalParts(result, 'Pacific/Auckland')).toMatchObject({
      year: 2026,
      month: 4,
      day: 6,
      weekday: 1,
      hour: 9,
      minute: 0,
    });
  });

  it('matches local weekday and wall-clock time across many timezones near midnight', () => {
    const zones = [
      'UTC',
      'Pacific/Honolulu',
      'America/Los_Angeles',
      'America/New_York',
      'America/Sao_Paulo',
      'Europe/London',
      'Europe/Berlin',
      'Asia/Kolkata',
      'Asia/Tokyo',
      'Australia/Sydney',
      'Pacific/Auckland',
    ];
    const base = new Date('2026-01-15T12:00:00Z');

    for (const timezone of zones) {
      for (const time of ['00:30', '23:30']) {
        const [expectedHour, expectedMinute] = time.split(':').map(Number);
        for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
          const rule: RecurrenceRule = {
            frequency: 'weekly',
            time,
            timezone,
            dayOfWeek,
          };
          const result = computeNextRun(rule, base);
          expect(new Date(result).getTime()).toBeGreaterThan(base.getTime());
          const local = getLocalParts(result, timezone);
          expect(local.weekday).toBe(dayOfWeek);
          expect(local.hour).toBe(expectedHour);
          expect(local.minute).toBe(expectedMinute);
        }
      }
    }
  });
});

describe('defaultRecurrenceRule', () => {
  it('returns a daily rule at 09:00 UTC with defaults', () => {
    expect(defaultRecurrenceRule()).toEqual({
      frequency: 'daily',
      time: '09:00',
      timezone: 'UTC',
      dayOfWeek: 1,
      dayOfMonth: 1,
    });
  });
});

describe('validateRecurrenceRule', () => {
  it('returns null for a valid daily rule', () => {
    expect(validateRecurrenceRule({ frequency: 'daily', time: '09:00', timezone: 'UTC' })).toBeNull();
  });

  it('returns null for a valid weekly rule with dayOfWeek', () => {
    expect(validateRecurrenceRule({ frequency: 'weekly', time: '10:00', timezone: 'America/New_York', dayOfWeek: 3 })).toBeNull();
  });

  it('returns null for a valid monthly rule with dayOfMonth', () => {
    expect(validateRecurrenceRule({ frequency: 'monthly', time: '02:00', timezone: 'UTC', dayOfMonth: 15 })).toBeNull();
  });

  it('fails when time is missing', () => {
    expect(validateRecurrenceRule({ frequency: 'daily', time: '', timezone: 'UTC' })).toBe('Time must be in HH:mm format');
  });

  it('fails when time is not HH:mm format', () => {
    expect(validateRecurrenceRule({ frequency: 'daily', time: '9:00', timezone: 'UTC' })).toBe('Time must be in HH:mm format');
  });

  it('fails when timezone is empty', () => {
    expect(validateRecurrenceRule({ frequency: 'daily', time: '09:00', timezone: '' })).toBe('Timezone is required');
  });

  it('fails when weekly rule has no dayOfWeek', () => {
    expect(validateRecurrenceRule({ frequency: 'weekly', time: '10:00', timezone: 'UTC' })).toBe('Day of week is required for weekly schedules');
  });

  it('fails when monthly rule dayOfMonth is out of range', () => {
    expect(validateRecurrenceRule({ frequency: 'monthly', time: '02:00', timezone: 'UTC', dayOfMonth: 0 })).toBe('Day of month must be between 1 and 31');
    expect(validateRecurrenceRule({ frequency: 'monthly', time: '02:00', timezone: 'UTC', dayOfMonth: 32 })).toBe('Day of month must be between 1 and 31');
  });
});

describe('validateScheduleForm', () => {
  it('returns null for a complete valid form', () => {
    expect(validateScheduleForm({ name: 'Test', format: 'csv', schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC' } })).toBeNull();
  });

  it('fails when name is empty', () => {
    expect(validateScheduleForm({ name: '  ', format: 'csv', schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC' } })).toBe('Name is required');
  });

  it('fails when format is unknown', () => {
    expect(validateScheduleForm({ name: 'Test', format: 'xls' as 'csv', schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC' } })).toBe('Format is required');
  });
});
