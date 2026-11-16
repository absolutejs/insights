import { and, desc, eq, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core";
import {
  insightActors,
  insightDailyActives,
  insightEvents,
  type EventProperties,
  type EventSource,
} from "./drizzle";

export type AnyPgDatabase = PgAsyncDatabase<any, any>;

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 26;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_FUNNEL_STEPS = 8;
const MAX_BATCH = 500;
const MEMO_LIMIT = 50_000;
/** A browser clock this far from the server's is not believed. */
const MAX_PAST_SKEW_MS = 3_600_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const NAME_PATTERN = /^[a-z][a-z0-9_.:-]{0,79}$/;
const MAX_PROPERTIES = 20;
const MAX_PROPERTY_LENGTH = 200;

export type TrackInput = {
  actorId: string;
  /** When it happened. Browser times are clamped to the server's clock. */
  at?: Date | number;
  name: string;
  path?: string;
  properties?: EventProperties;
  sessionId?: string;
  source?: EventSource;
  surface?: string;
};

export type InsightEvent = {
  actorId: string;
  at: number;
  id: number;
  name: string;
  path: string | null;
  properties: EventProperties;
  sessionId: string | null;
  source: EventSource;
  surface: string | null;
};

export type InsightPerson = {
  actorId: string;
  eventCount: number;
  firstSeenAt: number;
  label: string | null;
  lastSeenAt: number;
  signedUpAt: number | null;
};

export type ActiveDay = {
  /** People active that day. */
  dau: number;
  day: string;
  /** People active in the 30 days ending that day. */
  mau: number;
  /** People first seen that day. */
  new: number;
  /** People active in the 7 days ending that day. */
  wau: number;
};

export type RetentionCohort = {
  /** People in the cohort active N weeks after it started; index 0 is the
   *  cohort's own week. Weeks still in the future are absent. */
  active: number[];
  size: number;
  /** Monday of the cohort's week (UTC), as YYYY-MM-DD. */
  week: string;
};

export type FunnelStep = {
  /** Median time from the previous step, for people who reached this one. */
  medianFromPreviousMs: number | null;
  name: string;
  people: number;
};

export type FeatureUsage = {
  events: number;
  lastAt: number;
  name: string;
  people: number;
  /** People in the period before, for the trend. */
  previousPeople: number;
};

export type CreateInsightsOptions = {
  db: AnyPgDatabase;
  now?: () => number;
};

const rowsOf = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  const { rows } = result as { rows?: unknown };

  return Array.isArray(rows) ? (rows as T[]) : [];
};

const clamp = (value: number | undefined, fallback: number, max: number) =>
  Math.min(Math.max(Math.floor(value ?? fallback), 1), max);

const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);

const timeOf = (value: Date | string | number | null) => {
  if (value === null) return null;
  if (value instanceof Date) return value.getTime();

  return new Date(value).getTime();
};

/** Keeps properties to small scalars: a timeline row, not a payload. */
const cleanProperties = (properties: EventProperties | undefined) => {
  const clean: EventProperties = {};
  for (const [key, value] of Object.entries(properties ?? {}).slice(
    0,
    MAX_PROPERTIES,
  )) {
    if (key.length > 60) continue;
    clean[key] =
      typeof value === "string" ? value.slice(0, MAX_PROPERTY_LENGTH) : value;
  }

  return clean;
};

const toEvent = (row: typeof insightEvents.$inferSelect): InsightEvent => ({
  actorId: row.actor_id,
  at: row.at.getTime(),
  id: row.id,
  name: row.name,
  path: row.path,
  properties: row.properties,
  sessionId: row.session_id,
  source: row.source,
  surface: row.surface,
});

const toPerson = (row: typeof insightActors.$inferSelect): InsightPerson => ({
  actorId: row.actor_id,
  eventCount: row.event_count,
  firstSeenAt: row.first_seen_at.getTime(),
  label: row.label,
  lastSeenAt: row.last_seen_at.getTime(),
  signedUpAt: row.signed_up_at?.getTime() ?? null,
});

/**
 * Insights over Postgres: record what people do, and answer how many are
 * active, whether they come back, where they drop off, which features they
 * use, and what one person did.
 *
 * `markActive` is the cheap, exact signal: call it on every signed-in
 * request and it writes at most once per person per day (remembered in
 * memory). `track` records named events and also counts as activity.
 * Every read comes from the rollups or an indexed range of events, never a
 * scan of all of them.
 */
export const createInsights = ({
  db,
  now = Date.now,
}: CreateInsightsOptions) => {
  /* person:day pairs already written by this process. */
  const seen = new Set<string>();
  let seenDay = "";

  const touchActors = async (
    rows: { actorId: string; at: Date; count: number }[],
  ) => {
    for (const row of rows)
      await db
        .insert(insightActors)
        .values({
          actor_id: row.actorId,
          event_count: row.count,
          first_seen_at: row.at,
          last_seen_at: row.at,
        })
        .onConflictDoUpdate({
          set: {
            event_count: sql`${insightActors.event_count} + ${row.count}`,
            first_seen_at: sql`least(${insightActors.first_seen_at}, excluded.first_seen_at)`,
            last_seen_at: sql`greatest(${insightActors.last_seen_at}, excluded.last_seen_at)`,
          },
          target: insightActors.actor_id,
        });
  };

  const touchDays = async (rows: { actorId: string; day: string }[]) => {
    if (rows.length === 0) return;
    await db
      .insert(insightDailyActives)
      .values(rows.map((row) => ({ actor_id: row.actorId, day: row.day })))
      .onConflictDoNothing();
  };

  /** Counts the person active today. Writes at most once per person per
   *  day per process; safe to call on every request. */
  const markActive = async (actorId: string) => {
    const time = now();
    const day = dayOf(time);
    if (day !== seenDay) {
      seen.clear();
      seenDay = day;
    }
    const key = `${actorId}:${day}`;
    if (seen.has(key)) return false;
    if (seen.size >= MEMO_LIMIT) seen.clear();
    seen.add(key);
    const at = new Date(time);
    await touchActors([{ actorId, at, count: 0 }]);
    await touchDays([{ actorId, day }]);

    return true;
  };

  /** Records events (one or a batch). Names that are not lowercase-dotted
   *  are refused; a browser time more than an hour off the server's is
   *  replaced by now (server events keep theirs, so backfills work). */
  const track = async (input: TrackInput | TrackInput[]) => {
    const inputs = (Array.isArray(input) ? input : [input]).slice(0, MAX_BATCH);
    const time = now();
    const events = inputs.map((event) => {
      if (!NAME_PATTERN.test(event.name))
        throw new Error(`Event name "${event.name}" is not lowercase-dotted`);
      if (event.actorId.length === 0 || event.actorId.length > 128)
        throw new Error("An event needs an actor id of at most 128 characters");
      const given = event.at === undefined ? time : (timeOf(event.at) ?? time);
      /* A browser's clock is not trusted; the server's own times are. */
      const untrusted = event.source === "browser";
      const at =
        untrusted &&
        (given < time - MAX_PAST_SKEW_MS || given > time + MAX_FUTURE_SKEW_MS)
          ? time
          : given;

      return {
        actor_id: event.actorId,
        at: new Date(at),
        name: event.name,
        path: event.path?.slice(0, 512) ?? null,
        properties: cleanProperties(event.properties),
        session_id: event.sessionId?.slice(0, 64) ?? null,
        source: event.source ?? "server",
        surface: event.surface?.slice(0, 40) ?? null,
      };
    });
    if (events.length === 0) return 0;
    await db.insert(insightEvents).values(events);
    const byActor = new Map<string, { at: Date; count: number }>();
    const days = new Map<string, { actorId: string; day: string }>();
    for (const event of events) {
      const current = byActor.get(event.actor_id);
      byActor.set(event.actor_id, {
        at: current && current.at > event.at ? current.at : event.at,
        count: (current?.count ?? 0) + 1,
      });
      const day = dayOf(event.at.getTime());
      days.set(`${event.actor_id}:${day}`, { actorId: event.actor_id, day });
    }
    await touchActors(
      [...byActor].map(([actorId, value]) => ({ actorId, ...value })),
    );
    await touchDays([...days.values()]);

    return events.length;
  };

  /** Names the person on screen and records when they signed up (retention
   *  cohorts start there). */
  const identify = async (
    actorId: string,
    traits: { label?: string; signedUpAt?: Date | number },
  ) => {
    const signedUp =
      traits.signedUpAt === undefined ? undefined : new Date(traits.signedUpAt);
    const at = new Date(now());
    await db
      .insert(insightActors)
      .values({
        actor_id: actorId,
        first_seen_at: signedUp ?? at,
        label: traits.label?.slice(0, 320) ?? null,
        last_seen_at: signedUp ?? at,
        signed_up_at: signedUp ?? null,
      })
      .onConflictDoUpdate({
        set: {
          ...(traits.label === undefined
            ? {}
            : { label: traits.label.slice(0, 320) }),
          ...(signedUp === undefined
            ? {}
            : {
                first_seen_at: sql`least(${insightActors.first_seen_at}, ${signedUp})`,
                signed_up_at: signedUp,
              }),
        },
        target: insightActors.actor_id,
      });
  };

  /** Each day's active people, with the rolling 7- and 30-day counts and
   *  how many were new, oldest first. */
  const activeSeries = async (options: { days?: number } = {}) => {
    const days = clamp(options.days, DEFAULT_DAYS, MAX_DAYS);
    const end = dayOf(now());
    const rows = rowsOf<{
      dau: number;
      day: string;
      mau: number;
      new: number;
      wau: number;
    }>(
      await db.execute(sql`
        WITH series AS (
          SELECT generate_series(
            ${end}::date - ${days - 1}::int, ${end}::date, interval '1 day'
          )::date AS day
        )
        SELECT
          to_char(series.day, 'YYYY-MM-DD') AS day,
          (SELECT count(*)::int FROM ${insightDailyActives} a
            WHERE a.day = series.day) AS dau,
          (SELECT count(DISTINCT a.actor_id)::int FROM ${insightDailyActives} a
            WHERE a.day > series.day - ${WEEK_DAYS}::int AND a.day <= series.day) AS wau,
          (SELECT count(DISTINCT a.actor_id)::int FROM ${insightDailyActives} a
            WHERE a.day > series.day - ${MONTH_DAYS}::int AND a.day <= series.day) AS mau,
          (SELECT count(*)::int FROM ${insightActors} p
            WHERE p.first_seen_at >= series.day
              AND p.first_seen_at < series.day + 1) AS new
        FROM series
        ORDER BY series.day
      `),
    );

    return rows.map((row): ActiveDay => ({
      dau: Number(row.dau),
      day: row.day,
      mau: Number(row.mau),
      new: Number(row.new),
      wau: Number(row.wau),
    }));
  };

  /** Weekly cohorts (by signup, else first seen) and how many of each were
   *  active in each following week. */
  const retention = async (options: { weeks?: number } = {}) => {
    const weeks = clamp(options.weeks, DEFAULT_WEEKS, MAX_WEEKS);
    const today = dayOf(now());
    const rows = rowsOf<{
      active: number;
      size: number;
      week: string;
      week_offset: number;
    }>(
      await db.execute(sql`
        WITH people AS (
          SELECT actor_id,
            date_trunc('week', coalesce(signed_up_at, first_seen_at) AT TIME ZONE 'UTC')::date AS week
          FROM ${insightActors}
          WHERE coalesce(signed_up_at, first_seen_at) >= date_trunc('week', ${today}::date)::date - ${(weeks - 1) * WEEK_DAYS}::int
        ),
        sizes AS (SELECT week, count(*)::int AS size FROM people GROUP BY week),
        activity AS (
          SELECT people.week, ((a.day - people.week) / ${WEEK_DAYS})::int AS week_offset,
            count(DISTINCT a.actor_id)::int AS active
          FROM people
          JOIN ${insightDailyActives} a ON a.actor_id = people.actor_id AND a.day >= people.week
          GROUP BY people.week, week_offset
        )
        SELECT to_char(sizes.week, 'YYYY-MM-DD') AS week, sizes.size,
          coalesce(activity.week_offset, 0) AS week_offset, coalesce(activity.active, 0) AS active
        FROM sizes LEFT JOIN activity ON activity.week = sizes.week
        ORDER BY sizes.week, week_offset
      `),
    );
    const cohorts = new Map<string, RetentionCohort>();
    for (const row of rows) {
      const cohort = cohorts.get(row.week) ?? {
        active: [],
        size: Number(row.size),
        week: row.week,
      };
      cohort.active[Number(row.week_offset)] = Number(row.active);
      cohorts.set(row.week, cohort);
    }
    const todayTime = new Date(`${today}T00:00:00Z`).getTime();

    return [...cohorts.values()].map((cohort) => {
      const elapsed = Math.floor(
        (todayTime - new Date(`${cohort.week}T00:00:00Z`).getTime()) /
          (WEEK_DAYS * DAY_MS),
      );
      const active: number[] = [];
      for (let offset = 0; offset <= elapsed; offset += 1)
        active.push(cohort.active[offset] ?? 0);

      return { ...cohort, active };
    });
  };

  /** People who did the first step in the window, and how many went on to
   *  each next step in order (each after the one before, within `withinDays`
   *  of the first), with the median time between steps. */
  const funnel = async (options: {
    days?: number;
    steps: string[];
    withinDays?: number;
  }) => {
    const steps = options.steps.slice(0, MAX_FUNNEL_STEPS);
    if (steps.length === 0) return [];
    for (const step of steps)
      if (!NAME_PATTERN.test(step))
        throw new Error(`Funnel step "${step}" is not an event name`);
    const days = clamp(options.days, DEFAULT_DAYS, MAX_DAYS);
    const within = clamp(options.withinDays, days, MAX_DAYS);
    const since = new Date(now() - days * DAY_MS);
    const ctes: SQL[] = [
      sql`s0 AS (
        SELECT actor_id, min(at) AS at, min(at) AS started
        FROM ${insightEvents}
        WHERE name = ${steps[0]} AND at >= ${since}
        GROUP BY actor_id
      )`,
    ];
    for (let index = 1; index < steps.length; index += 1) {
      const previous = sql.raw(`s${index - 1}`);
      ctes.push(sql`${sql.raw(`s${index}`)} AS (
        SELECT e.actor_id, min(e.at) AS at, min(p.started) AS started,
          min(e.at) - min(p.at) AS gap
        FROM ${insightEvents} e
        JOIN ${previous} p ON p.actor_id = e.actor_id AND e.at >= p.at
          AND e.at <= p.started + ${within} * interval '1 day'
        WHERE e.name = ${steps[index]}
        GROUP BY e.actor_id
      )`);
    }
    const selects = steps.map((_, index) =>
      index === 0
        ? sql`SELECT 0 AS step, count(*)::int AS people, NULL::float AS median FROM s0`
        : sql`SELECT ${index} AS step, count(*)::int AS people,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM gap) * 1000) AS median
          FROM ${sql.raw(`s${index}`)}`,
    );
    const rows = rowsOf<{
      median: number | null;
      people: number;
      step: number;
    }>(
      await db.execute(
        sql`WITH ${sql.join(ctes, sql`, `)} ${sql.join(selects, sql` UNION ALL `)} ORDER BY step`,
      ),
    );

    return steps.map((name, index): FunnelStep => {
      const row = rows.find((candidate) => Number(candidate.step) === index);
      const median = row?.median;

      return {
        medianFromPreviousMs:
          median === null || median === undefined
            ? null
            : Math.round(Number(median)),
        name,
        people: Number(row?.people ?? 0),
      };
    });
  };

  /** Each event name used in the window: by how many people, how often,
   *  and how many people used it in the window before. */
  const featureUsage = async (
    options: { days?: number; exclude?: string[]; prefix?: string } = {},
  ) => {
    const days = clamp(options.days, DEFAULT_DAYS, MAX_DAYS);
    const time = now();
    const since = new Date(time - days * DAY_MS);
    const before = new Date(time - 2 * days * DAY_MS);
    const filters: SQL[] = [sql`at >= ${before}`];
    if (options.prefix)
      filters.push(
        sql`name LIKE ${`${options.prefix.replace(/[%_\\]/g, "")}%`}`,
      );
    if (options.exclude && options.exclude.length > 0)
      filters.push(
        sql`name NOT IN (${sql.join(
          options.exclude.map((name) => sql`${name}`),
          sql`, `,
        )})`,
      );
    const rows = rowsOf<{
      events: number;
      last_at: Date | string;
      name: string;
      people: number;
      previous_people: number;
    }>(
      await db.execute(sql`
        SELECT name,
          count(*) FILTER (WHERE at >= ${since})::int AS events,
          count(DISTINCT actor_id) FILTER (WHERE at >= ${since})::int AS people,
          count(DISTINCT actor_id) FILTER (WHERE at < ${since})::int AS previous_people,
          max(at) AS last_at
        FROM ${insightEvents}
        WHERE ${sql.join(filters, sql` AND `)}
        GROUP BY name
        HAVING count(*) FILTER (WHERE at >= ${since}) > 0
        ORDER BY people DESC, events DESC
      `),
    );

    return rows.map((row): FeatureUsage => ({
      events: Number(row.events),
      lastAt: timeOf(row.last_at) ?? 0,
      name: row.name,
      people: Number(row.people),
      previousPeople: Number(row.previous_people),
    }));
  };

  /** People, most recently active first, optionally searched by label or id. */
  const people = async (
    options: { limit?: number; offset?: number; query?: string } = {},
  ) => {
    const limit = clamp(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const query = options.query?.trim();
    const where = query
      ? or(
          ilike(insightActors.label, `%${query.replace(/[%_\\]/g, "")}%`),
          eq(insightActors.actor_id, query),
        )
      : undefined;
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(insightActors)
        .where(where)
        .orderBy(desc(insightActors.last_seen_at))
        .limit(limit)
        .offset(Math.max(0, options.offset ?? 0)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(insightActors)
        .where(where),
    ]);

    return { people: rows.map(toPerson), total: Number(total?.count ?? 0) };
  };

  /** One person: who they are, how active, and their most recent events
   *  (newest first; pass `before`, an event id, for the next page). */
  const person = async (
    actorId: string,
    options: { before?: number; days?: number; limit?: number } = {},
  ) => {
    const [row] = await db
      .select()
      .from(insightActors)
      .where(eq(insightActors.actor_id, actorId))
      .limit(1);
    if (!row) return null;
    const limit = clamp(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const days = clamp(options.days, DEFAULT_DAYS, MAX_DAYS);
    const sinceDay = dayOf(now() - (days - 1) * DAY_MS);
    const [events, [active]] = await Promise.all([
      db
        .select()
        .from(insightEvents)
        .where(
          and(
            eq(insightEvents.actor_id, actorId),
            options.before === undefined
              ? undefined
              : lt(insightEvents.id, options.before),
          ),
        )
        .orderBy(desc(insightEvents.at), desc(insightEvents.id))
        .limit(limit),
      db
        .select({ days: sql<number>`count(*)::int` })
        .from(insightDailyActives)
        .where(
          and(
            eq(insightDailyActives.actor_id, actorId),
            sql`${insightDailyActives.day} >= ${sinceDay}::date`,
          ),
        ),
    ]);

    return {
      activeDays: Number(active?.days ?? 0),
      events: events.map(toEvent),
      person: toPerson(row),
      windowDays: days,
    };
  };

  /** Deletes events older than `before`; the rollups stay (they hold no
   *  detail). Returns how many went. */
  const purgeEventsBefore = async (before: Date) => {
    const removed = await db
      .delete(insightEvents)
      .where(lt(insightEvents.at, before))
      .returning({ id: insightEvents.id });

    return removed.length;
  };

  /** Removes everything about one person (an erasure request). */
  const forget = async (actorId: string) => {
    await db.delete(insightEvents).where(eq(insightEvents.actor_id, actorId));
    await db
      .delete(insightDailyActives)
      .where(eq(insightDailyActives.actor_id, actorId));
    await db.delete(insightActors).where(eq(insightActors.actor_id, actorId));
    for (const key of seen) if (key.startsWith(`${actorId}:`)) seen.delete(key);
  };

  return {
    activeSeries,
    featureUsage,
    forget,
    funnel,
    identify,
    markActive,
    people,
    person,
    purgeEventsBefore,
    retention,
    track,
  };
};

export type Insights = ReturnType<typeof createInsights>;
