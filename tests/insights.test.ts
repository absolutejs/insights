/**
 * Insights against real Postgres (PGlite, in-process): the rollups, the
 * rolling counts, cohorts and funnels are all SQL a mock would not check.
 */
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { createInsights } from "../src/index";

const SCHEMA = `
  CREATE TABLE insight_events (
    actor_id varchar(128) NOT NULL,
    at timestamptz NOT NULL DEFAULT now(),
    id bigserial PRIMARY KEY,
    name varchar(80) NOT NULL,
    path varchar(512),
    properties jsonb NOT NULL DEFAULT '{}',
    session_id varchar(64),
    source varchar(16) NOT NULL DEFAULT 'server',
    surface varchar(40)
  );
  CREATE TABLE insight_actors (
    actor_id varchar(128) PRIMARY KEY,
    event_count integer NOT NULL DEFAULT 0,
    first_seen_at timestamptz NOT NULL,
    label varchar(320),
    last_seen_at timestamptz NOT NULL,
    signed_up_at timestamptz
  );
  CREATE TABLE insight_daily_actives (
    actor_id varchar(128) NOT NULL,
    day date NOT NULL,
    PRIMARY KEY (day, actor_id)
  );
`;

const DAY = 86_400_000;
/* A Wednesday, noon UTC: weeks start on the Monday two days before. */
const NOW = Date.UTC(2026, 10, 18, 12);

let clock = NOW;
let insights: ReturnType<typeof createInsights>;

beforeEach(async () => {
  const client = new PGlite();
  await client.exec(SCHEMA);
  clock = NOW;
  insights = createInsights({ db: drizzle({ client }), now: () => clock });
});

const at = (daysAgo: number, hours = 0) =>
  NOW - daysAgo * DAY + hours * 3_600_000;

describe("recording", () => {
  test("track keeps the event and counts the person active that day", async () => {
    await insights.track({
      actorId: "ada",
      name: "project.created",
      properties: { template: "react" },
      surface: "portal",
    });
    const detail = await insights.person("ada");

    expect(detail?.events.map((event) => event.name)).toEqual([
      "project.created",
    ]);
    expect(detail?.events[0]?.properties).toEqual({ template: "react" });
    expect(detail?.person.eventCount).toBe(1);
    expect(detail?.activeDays).toBe(1);
  });

  test("markActive writes once per person per day", async () => {
    expect(await insights.markActive("ada")).toBe(true);
    expect(await insights.markActive("ada")).toBe(false);
    clock = NOW + DAY;
    expect(await insights.markActive("ada")).toBe(true);
    expect((await insights.person("ada"))?.activeDays).toBe(2);
  });

  test("names must be lowercase-dotted, and a browser clock far off is replaced", async () => {
    await expect(
      insights.track({ actorId: "ada", name: "Project Created" }),
    ).rejects.toThrow("lowercase-dotted");
    await insights.track({
      actorId: "ada",
      at: NOW - 5 * DAY,
      name: "page.viewed",
      source: "browser",
    });
    const [event] = (await insights.person("ada"))?.events ?? [];

    expect(event?.at).toBe(NOW);
    expect(event?.source).toBe("browser");
  });

  test("identify labels the person and moves first seen back to signup", async () => {
    await insights.markActive("ada");
    await insights.identify("ada", {
      label: "ada@example.com",
      signedUpAt: at(10),
    });
    const { person } = (await insights.person("ada")) ?? {};

    expect(person?.label).toBe("ada@example.com");
    expect(person?.signedUpAt).toBe(at(10));
    expect(person?.firstSeenAt).toBe(at(10));
  });

  test("forget removes everything about a person", async () => {
    await insights.track({ actorId: "ada", name: "build.started" });
    await insights.forget("ada");

    expect(await insights.person("ada")).toBeNull();
    expect((await insights.people()).total).toBe(0);
  });
});

describe("reading", () => {
  test("active series: daily, rolling 7 and 30 days, and new people", async () => {
    await insights.track([
      { actorId: "ada", at: at(0), name: "page.viewed" },
      { actorId: "bob", at: at(0), name: "page.viewed" },
    ]);
    clock = at(3);
    await insights.markActive("cy");
    clock = NOW;
    const series = await insights.activeSeries({ days: 7 });
    const today = series.at(-1);

    expect(series).toHaveLength(7);
    expect(today).toMatchObject({ dau: 2, mau: 3, new: 2, wau: 3 });
    expect(series.find((day) => day.dau === 1)?.new).toBe(1);
  });

  test("retention: weekly cohorts and who came back", async () => {
    await insights.identify("ada", { signedUpAt: at(9) });
    await insights.identify("bob", { signedUpAt: at(9) });
    clock = at(9);
    await insights.markActive("ada");
    await insights.markActive("bob");
    clock = at(1);
    await insights.markActive("ada");
    clock = NOW;
    const cohorts = await insights.retention({ weeks: 4 });
    const cohort = cohorts.find((row) => row.size === 2);

    expect(cohort?.week).toBe("2026-11-09");
    expect(cohort?.active).toEqual([2, 1]);
  });

  test("funnel: in order, with the median time between steps", async () => {
    await insights.track([
      { actorId: "ada", at: at(2), name: "user.signed_up" },
      { actorId: "ada", at: at(2, 1), name: "project.created" },
      { actorId: "ada", at: at(2, 3), name: "release.published" },
      { actorId: "bob", at: at(1), name: "user.signed_up" },
      { actorId: "bob", at: at(1, 2), name: "project.created" },
      /* cy publishes before signing up: not counted past the first step. */
      { actorId: "cy", at: at(1), name: "release.published" },
      { actorId: "cy", at: at(0), name: "user.signed_up" },
    ]);
    const steps = await insights.funnel({
      days: 7,
      steps: ["user.signed_up", "project.created", "release.published"],
    });

    expect(steps.map((step) => step.people)).toEqual([3, 2, 1]);
    expect(steps[1]?.medianFromPreviousMs).toBe(1.5 * 3_600_000);
    expect(steps[2]?.medianFromPreviousMs).toBe(2 * 3_600_000);
  });

  test("feature usage: people, events and the period before", async () => {
    await insights.track([
      { actorId: "ada", at: at(1), name: "studio.chat.sent" },
      { actorId: "ada", at: at(1), name: "studio.chat.sent" },
      { actorId: "bob", at: at(2), name: "studio.chat.sent" },
      { actorId: "ada", at: at(10), name: "studio.chat.sent" },
      { actorId: "ada", at: at(1), name: "domain.added" },
    ]);
    const usage = await insights.featureUsage({ days: 7 });

    expect(usage[0]).toMatchObject({
      events: 3,
      name: "studio.chat.sent",
      people: 2,
      previousPeople: 1,
    });
    expect(usage.map((row) => row.name)).toContain("domain.added");
    expect(
      (await insights.featureUsage({ days: 7, exclude: ["domain.added"] })).map(
        (row) => row.name,
      ),
    ).toEqual(["studio.chat.sent"]);
  });

  test("people: most recent first, searchable by label", async () => {
    await insights.markActive("ada");
    await insights.identify("ada", { label: "ada@example.com" });
    clock = NOW + 1_000;
    await insights.markActive("bob");
    const all = await insights.people();

    expect(all.people.map((row) => row.actorId)).toEqual(["bob", "ada"]);
    expect((await insights.people({ query: "ada@" })).total).toBe(1);
  });
});
