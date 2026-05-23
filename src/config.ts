import { existsSync } from "node:fs";
import { z } from "zod";

const ConfigSchema = z.object({
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3210),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().trim().min(1).default("text-embedding-3-large"),
  IFSQN_DB_PATH: z.string().trim().min(1).default("../ifsqn-forum-scrape/data/ifsqn.sqlite3"),
  IFSQN_FTS_DB_PATH: z.string().trim().min(1).default("../ifsqn-forum-scrape/data/ifsqn_fts.sqlite3"),
  IFSQN_QDRANT_URL: z.string().url().default("http://127.0.0.1:6335"),
  IFSQN_COLLECTION: z.string().trim().min(1).default("ifsqn_forum_posts_large"),
  ELSMAR_DB_PATH: z.string().trim().min(1).default("../elsmar-forum-scrape/data/elsmar.sqlite3"),
  ELSMAR_FTS_DB_PATH: z.string().trim().min(1).default("../elsmar-forum-scrape/data/elsmar_fts.sqlite3"),
  ELSMAR_QDRANT_URL: z.string().url().default("http://127.0.0.1:6333"),
  ELSMAR_COLLECTION: z.string().trim().min(1).default("elsmar_forum_posts_large"),
  SQLITE3_BIN: z.string().trim().min(1).default("sqlite3"),
  MAX_CANDIDATES: z.coerce.number().int().min(5).max(200).default(60),
  MAX_RESULTS: z.coerce.number().int().min(1).max(50).default(20),
});

export type CorpusName = "ifsqn" | "elsmar";
export type SearchMode = "hybrid" | "keyword" | "vector";
export type AppConfig = z.infer<typeof ConfigSchema>;

export type CorpusConfig = {
  name: CorpusName;
  label: string;
  dbPath: string;
  ftsDbPath: string;
  qdrantUrl: string;
  collection: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return ConfigSchema.parse(env);
}

export function getCorpora(config: AppConfig, corpus: CorpusName | "both" = "both"): CorpusConfig[] {
  const corpora: Record<CorpusName, CorpusConfig> = {
    ifsqn: {
      name: "ifsqn",
      label: "IFSQN",
      dbPath: config.IFSQN_DB_PATH,
      ftsDbPath: config.IFSQN_FTS_DB_PATH,
      qdrantUrl: config.IFSQN_QDRANT_URL,
      collection: config.IFSQN_COLLECTION,
    },
    elsmar: {
      name: "elsmar",
      label: "Elsmar",
      dbPath: config.ELSMAR_DB_PATH,
      ftsDbPath: config.ELSMAR_FTS_DB_PATH,
      qdrantUrl: config.ELSMAR_QDRANT_URL,
      collection: config.ELSMAR_COLLECTION,
    },
  };

  return corpus === "both" ? [corpora.ifsqn, corpora.elsmar] : [corpora[corpus]];
}

export function corpusAvailability(corpus: CorpusConfig) {
  return {
    corpus: corpus.name,
    db: existsSync(corpus.dbPath),
    fts: existsSync(corpus.ftsDbPath),
    qdrant_url: corpus.qdrantUrl,
    collection: corpus.collection,
  };
}
