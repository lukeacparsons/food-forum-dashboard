# Food Forum Dashboard

Interactive dashboard for exploring IFSQN and Elsmar forum data.

## Features

- IFSQN online activity ranking and rolling 24h member/guest observation summaries.
- Hybrid post search across IFSQN, Elsmar, or both corpora.
- Vector-only, keyword-only, and hybrid modes.
- Topic drilldown with posts, metadata, and source links.

## Required env

- `OPENAI_API_KEY`
- `IFSQN_DB_PATH`
- `IFSQN_FTS_DB_PATH`
- `IFSQN_QDRANT_URL`
- `ELSMAR_DB_PATH`
- `ELSMAR_FTS_DB_PATH`
- `ELSMAR_QDRANT_URL`

Optional:

- `HOST` default `127.0.0.1`
- `PORT` default `3210`
- `SQLITE3_BIN` default `sqlite3`
- `IFSQN_COLLECTION` default `ifsqn_forum_posts_large`
- `ELSMAR_COLLECTION` default `elsmar_forum_posts_large`
