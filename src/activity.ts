import type { AppConfig } from "./config.js";
import { sqlLiteral, sqliteJson, sqliteOne } from "./sqlite.js";

type OverviewRow = {
  completed_snapshots: number;
  first_snapshot_utc: string | null;
  last_snapshot_utc: string | null;
  total_events: number;
  member_events: number;
  guest_or_bot_events: number;
  unique_member_ids: number;
  distinct_topics: number;
};

type TopicRow = {
  topic_id: number;
  observations: number;
  max_seen_at_once: number;
  snapshots_seen: number;
  member_observations: number;
  latest_activity_utc: string | null;
  title: string | null;
  forum_title: string | null;
  category_title: string | null;
  url: string | null;
};

type ActiveNowRow = {
  topic_id: number;
  active_now: number;
  members_now: number;
  title: string | null;
  forum_title: string | null;
  url: string | null;
};

type MemberRow = {
  member_id: number;
  display_name: string | null;
  profile_url: string | null;
  photo_url: string | null;
  group_title: string | null;
  country: string | null;
  active_posts: number | null;
  profile_views: number | null;
  observations: number;
  snapshots_seen: number;
  latest_activity_utc: string | null;
};

const MAX_ACTIVITY_RANGE_HOURS = 24 * 180;

function cutoffIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().replace(".000Z", "+00:00");
}

function limitValue(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

export async function getActivityOverview(config: AppConfig, rangeHoursValue: unknown) {
  const rangeHours = limitValue(rangeHoursValue, 24, MAX_ACTIVITY_RANGE_HOURS);
  const cutoff = cutoffIso(rangeHours);
  const row = await sqliteOne<OverviewRow>(config, config.IFSQN_DB_PATH, `
    SELECT
      COUNT(DISTINCT s.snapshot_id) AS completed_snapshots,
      MIN(s.completed_at) AS first_snapshot_utc,
      MAX(s.completed_at) AS last_snapshot_utc,
      COUNT(e.event_id) AS total_events,
      SUM(CASE WHEN e.member_id IS NOT NULL THEN 1 ELSE 0 END) AS member_events,
      SUM(CASE WHEN e.member_id IS NULL THEN 1 ELSE 0 END) AS guest_or_bot_events,
      COUNT(DISTINCT e.member_id) AS unique_member_ids,
      COUNT(DISTINCT e.topic_id) AS distinct_topics
    FROM online_activity_snapshots s
    JOIN online_activity_events e ON e.snapshot_id = s.snapshot_id
    WHERE s.status = 'completed'
      AND s.completed_at >= ${sqlLiteral(cutoff)}
  `);

  return {
    range_hours: rangeHours,
    cutoff_utc: cutoff,
    ...(row ?? {
      completed_snapshots: 0,
      first_snapshot_utc: null,
      last_snapshot_utc: null,
      total_events: 0,
      member_events: 0,
      guest_or_bot_events: 0,
      unique_member_ids: 0,
      distinct_topics: 0,
    }),
  };
}

export async function getActivityTopics(config: AppConfig, query: Record<string, unknown>) {
  const rangeHours = limitValue(query.rangeHours, 24, MAX_ACTIVITY_RANGE_HOURS);
  const limit = limitValue(query.limit, 25, 100);
  const cutoff = cutoffIso(rangeHours);
  const sort = query.sort === "latest" ? "latest_activity_utc DESC" : "observations DESC";

  return sqliteJson<TopicRow>(config, config.IFSQN_DB_PATH, `
    WITH grouped AS (
      SELECT
        e.topic_id,
        e.snapshot_id,
        COUNT(*) AS seen_in_snapshot,
        SUM(CASE WHEN e.member_id IS NOT NULL THEN 1 ELSE 0 END) AS members_in_snapshot,
        MAX(e.activity_at_utc) AS latest_activity_utc
      FROM online_activity_events e
      JOIN online_activity_snapshots s ON s.snapshot_id = e.snapshot_id
      WHERE s.status = 'completed'
        AND s.completed_at >= ${sqlLiteral(cutoff)}
        AND e.topic_id IS NOT NULL
      GROUP BY e.topic_id, e.snapshot_id
    )
    SELECT
      g.topic_id,
      SUM(g.seen_in_snapshot) AS observations,
      MAX(g.seen_in_snapshot) AS max_seen_at_once,
      COUNT(*) AS snapshots_seen,
      SUM(g.members_in_snapshot) AS member_observations,
      MAX(g.latest_activity_utc) AS latest_activity_utc,
      t.title,
      f.title AS forum_title,
      f.category_title,
      t.url
    FROM grouped g
    LEFT JOIN topics t ON t.topic_id = g.topic_id
    LEFT JOIN forums f ON f.forum_id = t.forum_id
    GROUP BY g.topic_id
    ORDER BY ${sort}
    LIMIT ${limit}
  `);
}

export async function getActiveNow(config: AppConfig) {
  return sqliteJson<ActiveNowRow>(config, config.IFSQN_DB_PATH, `
    WITH latest AS (
      SELECT snapshot_id
      FROM online_activity_snapshots
      WHERE status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    )
    SELECT
      e.topic_id,
      COUNT(*) AS active_now,
      SUM(CASE WHEN e.member_id IS NOT NULL THEN 1 ELSE 0 END) AS members_now,
      t.title,
      f.title AS forum_title,
      t.url
    FROM online_activity_events e
    JOIN latest l ON l.snapshot_id = e.snapshot_id
    LEFT JOIN topics t ON t.topic_id = e.topic_id
    LEFT JOIN forums f ON f.forum_id = t.forum_id
    WHERE e.topic_id IS NOT NULL
    GROUP BY e.topic_id
    ORDER BY active_now DESC
    LIMIT 20
  `);
}

export async function getMemberVisits(config: AppConfig, rangeHoursValue: unknown) {
  const rangeHours = limitValue(rangeHoursValue, 24, MAX_ACTIVITY_RANGE_HOURS);
  const cutoff = cutoffIso(rangeHours);
  const rows = await sqliteJson<MemberRow>(config, config.IFSQN_DB_PATH, `
    WITH visits AS (
      SELECT
        e.member_id,
        MAX(NULLIF(e.actor_name, '')) AS actor_name,
        COUNT(*) AS observations,
        COUNT(DISTINCT e.snapshot_id) AS snapshots_seen,
        MAX(e.activity_at_utc) AS latest_activity_utc
      FROM online_activity_events e
      JOIN online_activity_snapshots s ON s.snapshot_id = e.snapshot_id
      WHERE s.status = 'completed'
        AND s.completed_at >= ${sqlLiteral(cutoff)}
        AND e.member_id IS NOT NULL
      GROUP BY e.member_id
    )
    SELECT
      v.member_id,
      COALESCE(mp.display_name, md.display_name, v.actor_name) AS display_name,
      COALESCE(mp.profile_url, md.profile_url) AS profile_url,
      COALESCE(mp.photo_url, md.photo_url) AS photo_url,
      COALESCE(mp.group_title, md.group_title) AS group_title,
      mp.country,
      COALESCE(mp.active_posts, md.post_count) AS active_posts,
      mp.profile_views,
      v.observations,
      v.snapshots_seen,
      v.latest_activity_utc
    FROM visits v
    LEFT JOIN member_profiles mp ON mp.member_id = v.member_id
    LEFT JOIN members_directory md ON md.member_id = v.member_id
    ORDER BY observations DESC
    LIMIT 100
  `);

  return {
    range_hours: rangeHours,
    unique_member_ids: rows.length,
    members: rows,
  };
}
