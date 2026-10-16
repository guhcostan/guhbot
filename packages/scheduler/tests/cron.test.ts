import { afterAll, describe, expect, it } from 'vitest';
import { CronError, describeCron, isValidCron, matchesDay, nextFireTime, parseCron } from '../src/cron.js';

/**
 * These expectations are written for one time zone on purpose. Asserting a DST
 * transition in whatever zone the developer's laptop happens to use would pass
 * in Sao Paulo (which has had no DST since 2019) while proving nothing, so the
 * file pins the zone instead. Vitest runs each test file in its own process, and
 * the zone is restored afterwards, so nothing leaks into the other suites.
 */
const originalZone = process.env.TZ;
process.env.TZ = 'America/New_York';
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

afterAll(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

const at = (iso: string): Date => new Date(iso);
const next = (expression: string, from: string): string | null => {
  const fire = nextFireTime(parseCron(expression), at(from));
  return fire === null ? null : fire.toISOString();
};

describe('cron parsing', () => {
  it('ran in the zone the expectations were written for', () => {
    expect(ZONE).toBe('America/New_York');
  });

  it('expands a plain wildcard into every value of each field', () => {
    const schedule = parseCron('* * * * *');
    expect(schedule.minutes.size).toBe(60);
    expect(schedule.hours.size).toBe(24);
    expect(schedule.daysOfMonth.size).toBe(31);
    expect(schedule.months.size).toBe(12);
    expect(schedule.daysOfWeek.size).toBe(7);
    expect(schedule.dayOfMonthIsStar).toBe(true);
    expect(schedule.dayOfWeekIsStar).toBe(true);
  });

  it('steps across a whole range', () => {
    expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('* 9-17/2 * * *').hours]).toEqual([9, 11, 13, 15, 17]);
    expect([...parseCron('5/15 * * * *').minutes]).toEqual([5, 20, 35, 50]);
  });

  it('accepts ranges and lists', () => {
    expect([...parseCron('0 9-17 * * *').hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parseCron('0 0 1,15 * *').daysOfMonth]).toEqual([1, 15]);
    expect([...parseCron('0 9-17 * * 1-5').daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 1,15 1-6 *').months]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('treats 7 as Sunday', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
    expect([...parseCron('0 0 * * 5-7').daysOfWeek]).toEqual([5, 6, 0]);
  });

  it('treats a stepped star as unrestricted, the way Vixie cron does', () => {
    // `*/2` in a day field is a star field that selects every other value, so it
    // does not take part in the day-of-month OR day-of-week union.
    const schedule = parseCron('0 0 */2 * *');
    expect(schedule.dayOfMonthIsStar).toBe(true);
    expect(schedule.dayOfWeekIsStar).toBe(true);
  });

  it('describes itself without leaking anything but the expression', () => {
    expect(describeCron(parseCron('0 9-17 * * 1-5'))).toContain('0 9-17 * * 1-5');
  });

  it('accepts every expression shape the automations feature promises', () => {
    for (const expression of ['* * * * *', '*/15 * * * *', '0 9-17 * * 1-5', '0 0 1 * *', '30 2 29 2 *']) {
      expect(() => parseCron(expression)).not.toThrow();
      expect(parseCron(expression).expression).toBe(expression);
    }
  });

  it('reports validity as a boolean', () => {
    expect(isValidCron('0 0 * * *')).toBe(true);
    expect(isValidCron('0 0 * *')).toBe(false);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['* * * *', 'five fields'],
    ['* * * * * *', 'five fields'],
    ['60 * * * *', 'out of range 0-59'],
    ['* 24 * * *', 'out of range 0-23'],
    ['* * 0 * *', 'out of range 1-31'],
    ['* * 32 * *', 'out of range 1-31'],
    ['* * * 0 *', 'out of range 1-12'],
    ['* * * 13 *', 'out of range 1-12'],
    ['* * * * 8', 'out of range 0-7'],
    ['abc * * * *', 'not a number'],
    ['* * * * garbage', 'not a number'],
    ['1- * * * *', 'not a number'],
    ['*/0 * * * *', 'at least 1'],
    ['*/x * * * *', 'at least 1'],
    ['5-1 * * * *', 'counts backwards'],
    ['1,,2 * * * *', 'empty list item'],
    ['1/2/3 * * * *', 'more than one step'],
    ['* * * * * * *', 'five fields'],
  ])('refuses %j with a message naming the problem', (expression, expected) => {
    let thrown: unknown = null;
    try {
      parseCron(expression);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CronError);
    expect((thrown as Error).message).toContain(expected);
  });

  it('names the offending field in the refusal', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/cron minute field/);
    expect(() => parseCron('* * * 13 *')).toThrow(/cron month field/);
    expect(() => parseCron('abc * * * *')).toThrow(/cron minute field/);
  });
});

describe('next fire time', () => {
  it('crosses a month boundary', () => {
    expect(next('0 0 1 * *', '2026-01-15T17:00:00Z')).toBe('2026-02-01T05:00:00.000Z');
    expect(next('0 0 1 * *', '2026-02-01T05:00:00Z')).toBe('2026-03-01T05:00:00.000Z');
  });

  it('crosses a year boundary', () => {
    expect(next('0 0 1 1 *', '2026-12-31T23:00:00Z')).toBe('2027-01-01T05:00:00.000Z');
  });

  it('finds a leap day, and then the next one four years later', () => {
    expect(next('30 2 29 2 *', '2026-01-01T05:00:00Z')).toBe('2028-02-29T07:30:00.000Z');
    expect(next('30 2 29 2 *', '2028-02-29T07:30:00Z')).toBe('2032-02-29T07:30:00.000Z');
  });

  it('skips the century that is not a leap year', () => {
    // 2100 is not a leap year, so this is an eight-year gap. A parser that adds
    // four years at a time gets this wrong and silently skips 2104.
    expect(next('30 2 29 2 *', '2096-03-01T05:00:00Z')).toBe('2104-02-29T07:30:00.000Z');
  });

  it('refuses to pretend an impossible date exists', () => {
    expect(next('0 0 30 2 *', '2026-01-01T00:00:00Z')).toBeNull();
  });

  it('fires just after a spring-forward gap instead of skipping the day', () => {
    // 2026-03-08 02:00 EST becomes 03:00 EDT: 02:30 does not exist. The
    // occurrence fires at the instant the clock jumps to, not a day later.
    expect(next('30 2 * * *', '2026-03-07T09:00:00Z')).toBe('2026-03-08T07:30:00.000Z');
    expect(at('2026-03-08T07:30:00Z').toString()).toContain('03:30');
  });

  it('walks through a spring-forward gap in instant order, once per minute', () => {
    const fire = nextFireTime(parseCron('*/15 * * * *'), at('2026-03-08T06:45:00Z'));
    expect(fire?.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    const second = nextFireTime(parseCron('*/15 * * * *'), at('2026-03-08T07:00:00Z'));
    expect(second?.toISOString()).toBe('2026-03-08T07:15:00.000Z');
  });

  it('does not double-fire when the clock falls back', () => {
    // 2026-11-01 01:30 happens twice in this zone (EDT then EST). The schedule
    // is a wall-clock schedule, so it fires once.
    expect(next('30 1 * * *', '2026-11-01T04:00:00Z')).toBe('2026-11-01T05:30:00.000Z');
    expect(next('30 1 * * *', '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30:00.000Z');

    let cursor = at('2026-11-01T00:00:00Z');
    const fires: string[] = [];
    for (;;) {
      const fire = nextFireTime(parseCron('30 1 * * *'), cursor);
      if (fire === null || fire.getTime() > at('2026-11-02T12:00:00Z').getTime()) break;
      fires.push(fire.toISOString());
      cursor = fire;
    }
    expect(fires).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  });

  it('unions the day fields when both are restricted', () => {
    // "the 13th OR any Friday", which is the rule that is almost always
    // implemented as an intersection by accident.
    let cursor = at('2026-05-01T04:00:00Z');
    const fires: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const fire = nextFireTime(parseCron('0 0 13 * 5'), cursor);
      if (fire === null) throw new Error('expected a fire time');
      fires.push(fire.toISOString());
      cursor = fire;
    }
    expect(fires).toEqual([
      '2026-05-08T04:00:00.000Z', // a Friday that is not the 13th
      '2026-05-13T04:00:00.000Z', // a Wednesday that is the 13th
      '2026-05-15T04:00:00.000Z',
      '2026-05-22T04:00:00.000Z',
    ]);
  });

  it('intersects nothing when only one day field is restricted', () => {
    // With the day-of-week field left as a star, only the 13th matches.
    expect(next('0 0 13 * *', '2026-05-01T00:00:00Z')).toBe('2026-05-13T04:00:00.000Z');
    // With the day-of-month field left as a star, only Fridays match.
    expect(next('0 0 * * 5', '2026-05-01T00:00:00Z')).toBe('2026-05-01T04:00:00.000Z');
  });

  it('matches the restricted day field through matchesDay()', () => {
    const schedule = parseCron('0 0 13 * 5');
    expect(matchesDay(schedule, new Date(2026, 4, 13))).toBe(true); // Wednesday the 13th
    expect(matchesDay(schedule, new Date(2026, 4, 8))).toBe(true); // Friday the 8th
    expect(matchesDay(schedule, new Date(2026, 4, 14))).toBe(false); // Thursday the 14th
  });

  it('honours a business-hours expression', () => {
    expect(next('0 9-17 * * 1-5', '2026-05-01T12:00:00Z')).toBe('2026-05-01T13:00:00.000Z');
    // Saturday, so the next match is Monday 09:00 local (13:00Z).
    expect(next('0 9-17 * * 1-5', '2026-05-02T12:00:00Z')).toBe('2026-05-04T13:00:00.000Z');
  });

  it('never returns the instant it was given', () => {
    const fire = at('2026-05-01T13:00:00Z');
    expect(nextFireTime(parseCron('0 9-17 * * 1-5'), fire)?.toISOString()).toBe('2026-05-01T14:00:00.000Z');
  });

  it('accepts a mid-minute starting point without repeating the minute', () => {
    expect(next('* * * * *', '2026-05-01T12:00:30.500Z')).toBe('2026-05-01T12:01:00.000Z');
  });
});
