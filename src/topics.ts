import type { AppConfig, CorpusName } from "./config.js";
import { getCorpora } from "./config.js";
import { sqlLiteral, sqliteJson, sqliteOne } from "./sqlite.js";

type TopicRow = {
  topic_id: number;
  forum_id: number | null;
  title: string | null;
  url: string | null;
  page_count: number | null;
  last_post_at: string | null;
  forum_title: string | null;
  category_title: string | null;
  post_count: number;
};

type PostRow = {
  post_id: number;
  post_no: number | null;
  author_name: string | null;
  posted_at: string | null;
  source_url: string | null;
  post_url: string | null;
  text: string;
};

function topicSql(corpus: CorpusName, topicId: number): string {
  const categoryExpr = corpus === "ifsqn" ? "f.category_title" : "f.parent_title";
  const forumTitleExpr = corpus === "ifsqn" ? "f.title" : "COALESCE(t.forum_title, f.title)";
  return `
    SELECT
      t.topic_id,
      t.forum_id,
      t.title,
      t.url,
      t.page_count,
      t.last_post_at,
      ${forumTitleExpr} AS forum_title,
      ${categoryExpr} AS category_title,
      COUNT(p.post_id) AS post_count
    FROM topics t
    LEFT JOIN forums f ON f.forum_id = t.forum_id
    LEFT JOIN posts p ON p.topic_id = t.topic_id
    WHERE t.topic_id = ${sqlLiteral(topicId)}
    GROUP BY t.topic_id
  `;
}

function postsSql(corpus: CorpusName, topicId: number): string {
  const postUrlExpr = corpus === "ifsqn" ? "post_url" : "source_url AS post_url";
  return `
    SELECT
      post_id,
      post_no,
      author_name,
      posted_at,
      source_url,
      ${postUrlExpr},
      text
    FROM posts
    WHERE topic_id = ${sqlLiteral(topicId)}
    ORDER BY post_no, post_id
    LIMIT 300
  `;
}

export async function getTopic(config: AppConfig, corpusName: CorpusName, topicId: number) {
  const corpus = getCorpora(config, corpusName)[0];
  if (!corpus) {
    throw new Error(`Unknown corpus: ${corpusName}`);
  }

  const topic = await sqliteOne<TopicRow>(config, corpus.dbPath, topicSql(corpus.name, topicId));
  const posts = await sqliteJson<PostRow>(config, corpus.dbPath, postsSql(corpus.name, topicId));

  return { corpus: corpus.name, topic, posts };
}
