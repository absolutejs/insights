# @absolutejs/insights

Product insights for AbsoluteJS applications, on your own Postgres: record what
people do and answer how many are active, whether they come back, where they
drop off, which features they use, and what one person did.

- **Exact activity without tracking.** `markActive(personId)` on each
  signed-in request counts the person active that day, writing at most once
  per person per day. No browser script, no consent question.
- **Events where they happen.** `track({ actorId, name })` on the server for
  milestones (`user.signed_up`, `project.created`, `release.published`), and
  `createBrowserTracker` (`@absolutejs/insights/browser`) for interaction
  events from people who allowed it. The browser never names the person;
  your server does, from the session.
- **Reads that stay fast.** Active counts and retention read two small
  rollups (a row per person, a row per person per active day), never a scan
  of every event.

## Server

```ts
import { createInsights } from "@absolutejs/insights";

const insights = createInsights({ db });

await insights.markActive(user.id); // every signed-in request
await insights.identify(user.id, {
  label: user.email,
  signedUpAt: user.created_at,
});
await insights.track({
  actorId: user.id,
  name: "project.created",
  surface: "portal",
});

await insights.activeSeries({ days: 30 }); // [{ day, dau, wau, mau, new }]
await insights.retention({ weeks: 8 }); // [{ week, size, active: [n0, n1, …] }]
await insights.funnel({
  steps: ["user.signed_up", "project.created", "release.published"],
});
await insights.featureUsage({ days: 30 }); // [{ name, people, events, previousPeople }]
await insights.people({ query: "ada@" });
await insights.person(user.id); // the person, active days, recent events
await insights.forget(user.id); // erasure
```

Event names are lowercase and dotted (`studio.preview.opened`). Properties are
kept small (20 scalar values, 200 characters each): they are shown on a
timeline, not stored as a payload. A browser time more than an hour off the
server's clock is replaced by the server's.

## Browser

```ts
import { createBrowserTracker } from "@absolutejs/insights/browser";

const tracker = createBrowserTracker({
  enabled: () => consent.getState().choices.analytics,
  transport: (events) => client.api.insights.events.post({ events }),
});

tracker.track("studio.preview.opened", { device: "mobile" });
```

Nothing is queued or sent while `enabled()` is false. Batches flush every 10
seconds, at 50 events, and when the tab is hidden; a failed batch is dropped.

## Tables

`insight_events`, `insight_actors` and `insight_daily_actives`
(Drizzle tables, also from `@absolutejs/insights/drizzle`). Register them
with your migrations. `purgeEventsBefore(date)` trims old events; the rollups
keep the counts.

## License

BSL 1.1 — see [LICENSE](./LICENSE).
