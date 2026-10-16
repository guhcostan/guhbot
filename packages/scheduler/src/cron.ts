/**
 * Five-field cron — minute, hour, day-of-month, month, day-of-week — parsed and
 * evaluated here rather than pulled in as a dependency. The evaluation rules are
 * the part that has to be exactly right, and they are small enough to own.
 *
 * ## The day rule everybody gets wrong
 *
 * When BOTH day fields are restricted (neither was written with a leading star),
 * a date matches when the day-of-month matches OR the day-of-week matches. It is
 * a union, not an intersection: `0 0 1 * 1` fires on the 1st of the month and on
 * every Monday, not only on a Monday that happens to be the 1st. A parser that
 * treats the two fields as independent AND-ed predicates fires four times a
 * month where the user asked for once a week, and nobody notices until the
 * transcript is full.
 *
 * A field written with a leading star counts as unrestricted for this rule even
 * when it carries a step (`*` followed by `/2`), which is Vixie cron's behaviour:
 * it steps across the whole range, so it is a star field that happens to select
 * every other value.
 *
 * ## Time zone
 *
 * Schedules are wall-clock schedules in the host's local time zone, and the
 * search below builds candidate instants out of local calendar fields. Two
 * consequences are deliberate:
 *
 *  - **Spring forward.** A time inside the skipped hour does not exist. The
 *    candidate instant is the one the clock jumps to (03:30 for a `30 2 * * *`
 *    schedule in America/New_York), so the occurrence fires immediately after
 *    the gap rather than disappearing for the day.
 *  - **Fall back.** A wall-clock time that happens twice produces one candidate,
 *    so the occurrence fires once. A job that double-fires after a clock change
 *    is the bug users notice, and it is almost always a bug about comparing
 *    instants when the schedule meant wall-clock.
 *
 * The search picks the EARLIEST instant that matches each day rather than the
 * first wall-clock match, because across a spring-forward gap wall-clock order
 * and instant order disagree (`02:30` normalises to `03:30`, which is later than
 * `03:00`).
 */

/** Thrown for any expression this parser refuses. The message names the field. */
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export interface CronSchedule {
  /** The expression as written, trimmed. */
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0-6, Sunday is 0. `7` is accepted in the expression and normalised. */
  readonly daysOfWeek: ReadonlySet<number>;
  /** True when the day-of-month field started with a star. Drives the OR rule. */
  readonly dayOfMonthIsStar: boolean;
  /** True when the day-of-week field started with a star. Drives the OR rule. */
  readonly dayOfWeekIsStar: boolean;
  /** The day-of-month field as written, for diagnostics. */
  readonly dayOfMonthText: string;
  /** The day-of-week field as written, for diagnostics. */
  readonly dayOfWeekText: string;
}

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const MINUTE: FieldSpec = { name: 'minute', min: 0, max: 59 };
const HOUR: FieldSpec = { name: 'hour', min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { name: 'day-of-month', min: 1, max: 31 };
const MONTH: FieldSpec = { name: 'month', min: 1, max: 12 };
const DAY_OF_WEEK: FieldSpec = { name: 'day-of-week', min: 0, max: 7 };

/**
 * February 29 falls within eight years of any date, even across the 2100
 * century gap (2096 to 2104). Nine years of days is therefore a safe bound, and
 * it stops a syntactically valid but impossible expression such as `0 0 30 2 *`
 * from spinning forever.
 */
const MAX_SEARCH_DAYS = 366 * 9;

function parseNumber(text: string, spec: FieldSpec, item: string): number {
  if (!/^\d+$/.test(text)) {
    throw new CronError(
      `cron ${spec.name} field: "${item}" is not a number, a range (a-b), a step (with /n) or a list (a,b)`,
    );
  }
  const value = Number(text);
  if (value < spec.min || value > spec.max) {
    throw new CronError(`cron ${spec.name} field: ${value} is out of range ${spec.min}-${spec.max}`);
  }
  return value;
}

function parseField(text: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  const items = text.split(',');
  for (const raw of items) {
    const item = raw.trim();
    if (item.length === 0) {
      throw new CronError(`cron ${spec.name} field: "${text}" has an empty list item`);
    }

    const slash = item.indexOf('/');
    if (slash !== -1 && item.indexOf('/', slash + 1) !== -1) {
      throw new CronError(`cron ${spec.name} field: "${item}" has more than one step`);
    }
    const base = slash === -1 ? item : item.slice(0, slash);
    const stepText = slash === -1 ? null : item.slice(slash + 1);

    let step = 1;
    if (stepText !== null) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new CronError(`cron ${spec.name} field: step in "${item}" must be a whole number of at least 1`);
      }
      step = Number(stepText);
    }

    let start: number;
    let end: number;
    if (base === '*') {
      start = spec.min;
      end = spec.max;
    } else {
      const dash = base.indexOf('-');
      if (dash === -1) {
        start = parseNumber(base, spec, item);
        // A bare number with a step means "from here to the end of the range",
        // which is how `5/15` in the minute field reads in every cron dialect.
        end = stepText === null ? start : spec.max;
      } else {
        const fromText = base.slice(0, dash);
        const toText = base.slice(dash + 1);
        start = parseNumber(fromText, spec, item);
        end = parseNumber(toText, spec, item);
        if (end < start) {
          throw new CronError(`cron ${spec.name} field: range "${base}" counts backwards`);
        }
      }
    }

    for (let value = start; value <= end; value += step) {
      // Day-of-week accepts both 0 and 7 for Sunday; normalising here means the
      // matcher never has to think about it.
      values.add(spec === DAY_OF_WEEK && value === 7 ? 0 : value);
    }
  }

  if (values.size === 0) {
    throw new CronError(`cron ${spec.name} field: "${text}" selects no values`);
  }
  return values;
}

/** Parse a five-field expression. Throws `CronError` with a message naming the field. */
export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== 'string') {
    throw new CronError('cron expression must be a string');
  }
  const text = expression.trim();
  if (text.length === 0) {
    throw new CronError('cron expression is empty');
  }
  const fields = text.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `cron expression must have exactly five fields (minute hour day-of-month month day-of-week), got ${fields.length} in "${text}"`,
    );
  }

  const minuteText = fields[0]!;
  const hourText = fields[1]!;
  const domText = fields[2]!;
  const monthText = fields[3]!;
  const dowText = fields[4]!;

  return {
    expression: text,
    minutes: parseField(minuteText, MINUTE),
    hours: parseField(hourText, HOUR),
    daysOfMonth: parseField(domText, DAY_OF_MONTH),
    months: parseField(monthText, MONTH),
    daysOfWeek: parseField(dowText, DAY_OF_WEEK),
    dayOfMonthIsStar: domText.startsWith('*'),
    dayOfWeekIsStar: dowText.startsWith('*'),
    dayOfMonthText: domText,
    dayOfWeekText: dowText,
  };
}

/** True when `expression` parses. Used where a boolean answer reads better than a throw. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a calendar date matches the schedule's day fields.
 *
 * Exported because the OR rule is the thing worth testing directly, and because
 * a misleading day rule is invisible in a schedule that happens to have one
 * restricted field.
 */
export function matchesDay(schedule: CronSchedule, date: Date): boolean {
  const dayOfMonth = schedule.daysOfMonth.has(date.getDate());
  const dayOfWeek = schedule.daysOfWeek.has(date.getDay());

  if (!schedule.dayOfMonthIsStar && !schedule.dayOfWeekIsStar) return dayOfMonth || dayOfWeek;
  if (!schedule.dayOfMonthIsStar) return dayOfMonth;
  if (!schedule.dayOfWeekIsStar) return dayOfWeek;
  return true;
}

function earliestOnDay(schedule: CronSchedule, day: Date, after: number): Date | null {
  const year = day.getFullYear();
  const month = day.getMonth();
  const date = day.getDate();
  let best: Date | null = null;

  for (const hour of schedule.hours) {
    for (const minute of schedule.minutes) {
      const instant = new Date(year, month, date, hour, minute);
      // A time inside a spring-forward gap does not exist; the constructor
      // normalises it forward to the first instant after the gap, which is
      // exactly where the occurrence should fire.
      if (instant.getTime() <= after) continue;
      if (best === null || instant.getTime() < best.getTime()) best = instant;
    }
  }
  return best;
}

/**
 * The first instant strictly after `from` that the schedule selects, or null
 * when the expression can never match a real date (`0 0 30 2 *`).
 */
export function nextFireTime(schedule: CronSchedule, from: Date): Date | null {
  if (Number.isNaN(from.getTime())) {
    throw new CronError('next-fire time was asked for an invalid date');
  }

  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    // Every instant on this day is already past; skip without scanning minutes.
    const nextMidnight = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    if (nextMidnight.getTime() <= from.getTime()) continue;
    if (!schedule.months.has(day.getMonth() + 1)) continue;
    if (!matchesDay(schedule, day)) continue;
    const candidate = earliestOnDay(schedule, day, from.getTime());
    if (candidate !== null) return candidate;
  }
  return null;
}

/** Explain a schedule in one line, for tool output and diagnostics. */
export function describeCron(schedule: CronSchedule): string {
  const dom = schedule.dayOfMonthIsStar ? 'every day-of-month' : `day-of-month ${schedule.dayOfMonthText}`;
  const dow = schedule.dayOfWeekIsStar ? 'every day-of-week' : `day-of-week ${schedule.dayOfWeekText}`;
  return `${schedule.expression} (minute ${[...schedule.minutes].join(',')}; hour ${[...schedule.hours].join(',')}; ${dom}; ${dow})`;
}
