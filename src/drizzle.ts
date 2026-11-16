/**
 * The tables behind insights.
 *
 * An event is one thing a person did ("project.created", "build.started"),
 * recorded where it happened: on the server (exact, needs no consent) or in
 * the browser (only for people who allowed it). Two small rollups keep every
 * read off the raw events as they grow: one row per person (first and last
 * seen, how many events), and one row per person per day they were active,
 * which is what active-people counts and retention cohorts read.
 */
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  bigserial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const EVENT_SOURCES = ["server", "browser"] as const;
/** `server`: recorded where it happened, for everyone. `browser`: sent by
 *  the page, only for people who allowed it. */
export type EventSource = (typeof EVENT_SOURCES)[number];

/** Whatever the application wants to keep with an event. Keep it small and
 *  free of secrets and personal data: it is shown to whoever reads the
 *  timeline. */
export type EventProperties = Record<string, string | number | boolean | null>;

export const insightEvents = pgTable(
  "insight_events",
  {
    /** The application's own id for the person. */
    actor_id: varchar({ length: 128 }).notNull(),
    at: timestamp({ mode: "date", withTimezone: true }).notNull().defaultNow(),
    id: bigserial({ mode: "number" }).primaryKey(),
    /** Lowercase, dotted: `project.created`, `studio.preview.opened`. */
    name: varchar({ length: 80 }).notNull(),
    path: varchar({ length: 512 }),
    properties: jsonb().$type<EventProperties>().notNull().default({}),
    /** The browser tab's session, for browser events. */
    session_id: varchar({ length: 64 }),
    source: varchar({ length: 16 })
      .$type<EventSource>()
      .notNull()
      .default("server"),
    /** The application's surface: `portal`, `studio`, `api`… */
    surface: varchar({ length: 40 }),
  },
  (table) => [
    index("insight_events_actor_idx").on(table.actor_id, table.at),
    index("insight_events_name_idx").on(table.name, table.at),
    index("insight_events_at_idx").on(table.at),
  ],
);

export const insightActors = pgTable(
  "insight_actors",
  {
    actor_id: varchar({ length: 128 }).primaryKey(),
    event_count: integer().notNull().default(0),
    first_seen_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    /** How the application names the person on screen (an email, a name). */
    label: varchar({ length: 320 }),
    last_seen_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
    /** When they signed up, when the application says so; retention cohorts
     *  use it, falling back to when they were first seen. */
    signed_up_at: timestamp({ mode: "date", withTimezone: true }),
  },
  (table) => [
    index("insight_actors_last_seen_idx").on(table.last_seen_at),
    index("insight_actors_first_seen_idx").on(table.first_seen_at),
  ],
);

export const insightDailyActives = pgTable(
  "insight_daily_actives",
  {
    actor_id: varchar({ length: 128 }).notNull(),
    /** The UTC day they were active. */
    day: date({ mode: "string" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.actor_id] }),
    index("insight_daily_actives_actor_idx").on(table.actor_id, table.day),
  ],
);

export const insightsDrizzleSchema = {
  insightActors,
  insightDailyActives,
  insightEvents,
};
