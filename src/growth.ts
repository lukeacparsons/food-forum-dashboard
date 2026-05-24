import type { AppConfig } from "./config.js";
import { sqlLiteral, sqliteJson, sqliteOne } from "./sqlite.js";

type GrowthPoint = {
  date: string;
  new_topics: number;
  posts: number;
  new_topics_ma14: number;
  posts_ma14: number;
};

type GrowthSummary = {
  first_date: string | null;
  last_date: string | null;
  days: number;
  total_new_topics: number;
  total_posts: number;
  avg_new_topics_14d: number;
  avg_posts_14d: number;
};

const MAX_RANGE_DAYS = 365 * 30;

function rangeDays(value: unknown): number | null {
  if (value === "all" || value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(1, Math.min(Math.trunc(parsed), MAX_RANGE_DAYS));
}

export async function getIfsqnGrowth(config: AppConfig, rangeDaysValue: unknown) {
  const days = rangeDays(rangeDaysValue);
  const dateBounds = await sqliteOne<{ min_date: string | null; max_date: string | null }>(config, config.IFSQN_DB_PATH, `
    SELECT
      MIN(date(posted_at)) AS min_date,
      MAX(date(posted_at)) AS max_date
    FROM posts
    WHERE posted_at IS NOT NULL
      AND posted_at != ''
  `);

  if (!dateBounds?.min_date || !dateBounds.max_date) {
    return {
      range_days: days ?? "all",
      summary: {
        first_date: null,
        last_date: null,
        days: 0,
        total_new_topics: 0,
        total_posts: 0,
        avg_new_topics_14d: 0,
        avg_posts_14d: 0,
      },
      series: [],
    };
  }

  const startDate = days
    ? `date(${sqlLiteral(dateBounds.max_date)}, '-${days - 1} days')`
    : sqlLiteral(dateBounds.min_date);
  const endDate = sqlLiteral(dateBounds.max_date);

  const series = await sqliteJson<GrowthPoint>(config, config.IFSQN_DB_PATH, `
    WITH RECURSIVE dates(day) AS (
      SELECT ${startDate}
      UNION ALL
      SELECT date(day, '+1 day')
      FROM dates
      WHERE day < ${endDate}
    ),
    daily_posts AS (
      SELECT date(posted_at) AS day, COUNT(*) AS posts
      FROM posts
      WHERE posted_at IS NOT NULL
        AND posted_at != ''
        AND date(posted_at) BETWEEN (SELECT MIN(day) FROM dates) AND ${endDate}
      GROUP BY day
    ),
    topic_first_posts AS (
      SELECT topic_id, MIN(date(posted_at)) AS day
      FROM posts
      WHERE posted_at IS NOT NULL
        AND posted_at != ''
      GROUP BY topic_id
    ),
    daily_topics AS (
      SELECT day, COUNT(*) AS new_topics
      FROM topic_first_posts
      WHERE day BETWEEN (SELECT MIN(day) FROM dates) AND ${endDate}
      GROUP BY day
    ),
    daily AS (
      SELECT
        d.day AS date,
        COALESCE(t.new_topics, 0) AS new_topics,
        COALESCE(p.posts, 0) AS posts
      FROM dates d
      LEFT JOIN daily_topics t ON t.day = d.day
      LEFT JOIN daily_posts p ON p.day = d.day
    )
    SELECT
      date,
      new_topics,
      posts,
      ROUND(AVG(new_topics) OVER (ORDER BY date ROWS BETWEEN 13 PRECEDING AND CURRENT ROW), 3) AS new_topics_ma14,
      ROUND(AVG(posts) OVER (ORDER BY date ROWS BETWEEN 13 PRECEDING AND CURRENT ROW), 3) AS posts_ma14
    FROM daily
    ORDER BY date
  `, 60_000);

  const summary = series.reduce<GrowthSummary>((acc, point) => ({
    first_date: acc.first_date ?? point.date,
    last_date: point.date,
    days: acc.days + 1,
    total_new_topics: acc.total_new_topics + Number(point.new_topics || 0),
    total_posts: acc.total_posts + Number(point.posts || 0),
    avg_new_topics_14d: Number(point.new_topics_ma14 || 0),
    avg_posts_14d: Number(point.posts_ma14 || 0),
  }), {
    first_date: null,
    last_date: null,
    days: 0,
    total_new_topics: 0,
    total_posts: 0,
    avg_new_topics_14d: 0,
    avg_posts_14d: 0,
  });

  return {
    range_days: days ?? "all",
    summary,
    series,
  };
}
