import type { AppConfig } from "./config.js";
import { sqlLiteral, sqliteJson, sqliteOne } from "./sqlite.js";

type GrowthPoint = {
  date: string;
  new_topics: number;
  posts: number;
  new_topics_ma30: number;
  posts_ma30: number;
};

type GrowthSummary = {
  first_date: string | null;
  last_date: string | null;
  days: number;
  total_new_topics: number;
  total_posts: number;
  avg_new_topics_30d: number;
  avg_posts_30d: number;
};

type MemberGrowthPoint = {
  date: string;
  new_members: number;
  new_members_ma7: number;
};

type MemberGrowthSummary = {
  first_date: string | null;
  last_date: string | null;
  days: number;
  total_new_members: number;
  avg_new_members_7d: number;
};

type MemberRetentionCohort = {
  signup_year: number;
  cohort_size: number;
  active_members: number;
  active_pct: number;
};

type MemberRetentionSummary = {
  latest_activity_date: string | null;
  active_since_date: string | null;
  cohort_count: number;
  total_members: number;
  members_with_activity_date: number;
  active_members: number;
  overall_active_pct: number;
};

const MAX_RANGE_DAYS = 365 * 30;
const MOVING_AVERAGE_DAYS = 30;
const MEMBER_MOVING_AVERAGE_DAYS = 7;

const PARSED_MEMBER_JOINED_DATE = `
  date(
    substr(member_since_text, 8, 4) || '-' ||
    CASE substr(member_since_text, 4, 3)
      WHEN 'Jan' THEN '01'
      WHEN 'Feb' THEN '02'
      WHEN 'Mar' THEN '03'
      WHEN 'Apr' THEN '04'
      WHEN 'May' THEN '05'
      WHEN 'Jun' THEN '06'
      WHEN 'Jul' THEN '07'
      WHEN 'Aug' THEN '08'
      WHEN 'Sep' THEN '09'
      WHEN 'Oct' THEN '10'
      WHEN 'Nov' THEN '11'
      WHEN 'Dec' THEN '12'
    END || '-' ||
    substr(member_since_text, 1, 2)
  )
`;

const PARSED_MEMBER_LAST_ACTIVE_DATE = `
  CASE
    WHEN last_active_text LIKE 'Last Active Today,%' THEN date(fetched_at)
    WHEN last_active_text LIKE 'Last Active Yesterday,%' THEN date(fetched_at, '-1 day')
    WHEN last_active_text LIKE 'Last Active ___ __ ____ __:__ __' THEN date(
      substr(last_active_text, 20, 4) || '-' ||
      CASE substr(last_active_text, 13, 3)
        WHEN 'Jan' THEN '01'
        WHEN 'Feb' THEN '02'
        WHEN 'Mar' THEN '03'
        WHEN 'Apr' THEN '04'
        WHEN 'May' THEN '05'
        WHEN 'Jun' THEN '06'
        WHEN 'Jul' THEN '07'
        WHEN 'Aug' THEN '08'
        WHEN 'Sep' THEN '09'
        WHEN 'Oct' THEN '10'
        WHEN 'Nov' THEN '11'
        WHEN 'Dec' THEN '12'
      END || '-' ||
      substr(last_active_text, 17, 2)
    )
  END
`;

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
        avg_new_topics_30d: 0,
        avg_posts_30d: 0,
      },
      series: [],
    };
  }

  const displayStartDate = days
    ? `MAX(${sqlLiteral(dateBounds.min_date)}, date(${sqlLiteral(dateBounds.max_date)}, '-${days - 1} days'))`
    : sqlLiteral(dateBounds.min_date);
  const calculationStartDate = days
    ? `MAX(${sqlLiteral(dateBounds.min_date)}, date(${sqlLiteral(dateBounds.max_date)}, '-${days + MOVING_AVERAGE_DAYS - 2} days'))`
    : sqlLiteral(dateBounds.min_date);
  const endDate = sqlLiteral(dateBounds.max_date);

  const series = await sqliteJson<GrowthPoint>(config, config.IFSQN_DB_PATH, `
    WITH RECURSIVE dates(day) AS (
      SELECT ${calculationStartDate}
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
    ),
    with_moving_average AS (
      SELECT
        date,
        new_topics,
        posts,
        ROUND(AVG(new_topics) OVER (ORDER BY date ROWS BETWEEN ${MOVING_AVERAGE_DAYS - 1} PRECEDING AND CURRENT ROW), 3) AS new_topics_ma30,
        ROUND(AVG(posts) OVER (ORDER BY date ROWS BETWEEN ${MOVING_AVERAGE_DAYS - 1} PRECEDING AND CURRENT ROW), 3) AS posts_ma30
      FROM daily
    )
    SELECT
      date,
      new_topics,
      posts,
      new_topics_ma30,
      posts_ma30
    FROM with_moving_average
    WHERE date >= ${displayStartDate}
    ORDER BY date
  `, 60_000);

  const summary = series.reduce<GrowthSummary>((acc, point) => ({
    first_date: acc.first_date ?? point.date,
    last_date: point.date,
    days: acc.days + 1,
    total_new_topics: acc.total_new_topics + Number(point.new_topics || 0),
    total_posts: acc.total_posts + Number(point.posts || 0),
    avg_new_topics_30d: Number(point.new_topics_ma30 || 0),
    avg_posts_30d: Number(point.posts_ma30 || 0),
  }), {
    first_date: null,
    last_date: null,
    days: 0,
    total_new_topics: 0,
    total_posts: 0,
    avg_new_topics_30d: 0,
    avg_posts_30d: 0,
  });

  return {
    range_days: days ?? "all",
    moving_average_days: MOVING_AVERAGE_DAYS,
    summary,
    series,
  };
}

export async function getIfsqnMemberGrowth(config: AppConfig, rangeDaysValue: unknown) {
  const days = rangeDays(rangeDaysValue);
  const dateBounds = await sqliteOne<{ min_date: string | null; max_date: string | null }>(config, config.IFSQN_DB_PATH, `
    WITH parsed_members AS (
      SELECT ${PARSED_MEMBER_JOINED_DATE} AS joined_date
      FROM member_profiles
      WHERE member_since_text IS NOT NULL
        AND member_since_text != ''
    )
    SELECT
      MIN(joined_date) AS min_date,
      MAX(joined_date) AS max_date
    FROM parsed_members
    WHERE joined_date IS NOT NULL
  `);

  if (!dateBounds?.min_date || !dateBounds.max_date) {
    return {
      range_days: days ?? "all",
      moving_average_days: MEMBER_MOVING_AVERAGE_DAYS,
      summary: {
        first_date: null,
        last_date: null,
        days: 0,
        total_new_members: 0,
        avg_new_members_7d: 0,
      },
      series: [],
    };
  }

  const displayStartDate = days
    ? `MAX(${sqlLiteral(dateBounds.min_date)}, date(${sqlLiteral(dateBounds.max_date)}, '-${days - 1} days'))`
    : sqlLiteral(dateBounds.min_date);
  const calculationStartDate = days
    ? `MAX(${sqlLiteral(dateBounds.min_date)}, date(${sqlLiteral(dateBounds.max_date)}, '-${days + MEMBER_MOVING_AVERAGE_DAYS - 2} days'))`
    : sqlLiteral(dateBounds.min_date);
  const endDate = sqlLiteral(dateBounds.max_date);

  const series = await sqliteJson<MemberGrowthPoint>(config, config.IFSQN_DB_PATH, `
    WITH RECURSIVE dates(day) AS (
      SELECT ${calculationStartDate}
      UNION ALL
      SELECT date(day, '+1 day')
      FROM dates
      WHERE day < ${endDate}
    ),
    parsed_members AS (
      SELECT ${PARSED_MEMBER_JOINED_DATE} AS joined_date
      FROM member_profiles
      WHERE member_since_text IS NOT NULL
        AND member_since_text != ''
    ),
    daily_members AS (
      SELECT joined_date AS day, COUNT(*) AS new_members
      FROM parsed_members
      WHERE joined_date BETWEEN (SELECT MIN(day) FROM dates) AND ${endDate}
      GROUP BY joined_date
    ),
    daily AS (
      SELECT
        d.day AS date,
        COALESCE(m.new_members, 0) AS new_members
      FROM dates d
        LEFT JOIN daily_members m ON m.day = d.day
    ),
    with_moving_average AS (
      SELECT
        date,
        new_members,
        ROUND(AVG(new_members) OVER (ORDER BY date ROWS BETWEEN ${MEMBER_MOVING_AVERAGE_DAYS - 1} PRECEDING AND CURRENT ROW), 3) AS new_members_ma7
      FROM daily
    )
    SELECT
      date,
      new_members,
      new_members_ma7
    FROM with_moving_average
    WHERE date >= ${displayStartDate}
    ORDER BY date
  `, 60_000);

  const summary = series.reduce<MemberGrowthSummary>((acc, point) => ({
    first_date: acc.first_date ?? point.date,
    last_date: point.date,
    days: acc.days + 1,
    total_new_members: acc.total_new_members + Number(point.new_members || 0),
    avg_new_members_7d: Number(point.new_members_ma7 || 0),
  }), {
    first_date: null,
    last_date: null,
    days: 0,
    total_new_members: 0,
    avg_new_members_7d: 0,
  });

  return {
    range_days: days ?? "all",
    moving_average_days: MEMBER_MOVING_AVERAGE_DAYS,
    summary,
    series,
  };
}

export async function getIfsqnMemberRetention(config: AppConfig) {
  const cohorts = await sqliteJson<MemberRetentionCohort>(config, config.IFSQN_DB_PATH, `
    WITH parsed_members AS (
      SELECT
        CAST(strftime('%Y', ${PARSED_MEMBER_JOINED_DATE}) AS INTEGER) AS signup_year,
        ${PARSED_MEMBER_JOINED_DATE} AS joined_date,
        ${PARSED_MEMBER_LAST_ACTIVE_DATE} AS last_active_date
      FROM member_profiles
      WHERE member_since_text IS NOT NULL
        AND member_since_text != ''
    ),
    bounds AS (
      SELECT
        MAX(last_active_date) AS latest_activity_date,
        date(MAX(last_active_date), '-3 months') AS active_since_date
      FROM parsed_members
      WHERE last_active_date IS NOT NULL
    )
    SELECT
      p.signup_year,
      COUNT(*) AS cohort_size,
      SUM(CASE WHEN p.last_active_date >= b.active_since_date THEN 1 ELSE 0 END) AS active_members,
      ROUND(100.0 * SUM(CASE WHEN p.last_active_date >= b.active_since_date THEN 1 ELSE 0 END) / COUNT(*), 1) AS active_pct
    FROM parsed_members p
      CROSS JOIN bounds b
    WHERE p.joined_date IS NOT NULL
      AND p.signup_year IS NOT NULL
    GROUP BY p.signup_year
    ORDER BY p.signup_year DESC
  `, 60_000);

  const summary = await sqliteOne<MemberRetentionSummary>(config, config.IFSQN_DB_PATH, `
    WITH parsed_members AS (
      SELECT
        CAST(strftime('%Y', ${PARSED_MEMBER_JOINED_DATE}) AS INTEGER) AS signup_year,
        ${PARSED_MEMBER_JOINED_DATE} AS joined_date,
        ${PARSED_MEMBER_LAST_ACTIVE_DATE} AS last_active_date
      FROM member_profiles
      WHERE member_since_text IS NOT NULL
        AND member_since_text != ''
    ),
    bounds AS (
      SELECT
        MAX(last_active_date) AS latest_activity_date,
        date(MAX(last_active_date), '-3 months') AS active_since_date
      FROM parsed_members
      WHERE last_active_date IS NOT NULL
    )
    SELECT
      b.latest_activity_date,
      b.active_since_date,
      COUNT(DISTINCT p.signup_year) AS cohort_count,
      COUNT(*) AS total_members,
      SUM(CASE WHEN p.last_active_date IS NOT NULL THEN 1 ELSE 0 END) AS members_with_activity_date,
      SUM(CASE WHEN p.last_active_date >= b.active_since_date THEN 1 ELSE 0 END) AS active_members,
      ROUND(100.0 * SUM(CASE WHEN p.last_active_date >= b.active_since_date THEN 1 ELSE 0 END) / COUNT(*), 1) AS overall_active_pct
    FROM parsed_members p
      CROSS JOIN bounds b
    WHERE p.joined_date IS NOT NULL
      AND p.signup_year IS NOT NULL
  `, 60_000);

  return {
    active_window_months: 3,
    summary: summary ?? {
      latest_activity_date: null,
      active_since_date: null,
      cohort_count: 0,
      total_members: 0,
      members_with_activity_date: 0,
      active_members: 0,
      overall_active_pct: 0,
    },
    cohorts,
  };
}
