# Link Fetcher

Temporary, independent link collection board. This project does not modify SuperProxy or ShadowLinks.

## What it does

- Live-updating dashboard: automatically checks for new links every 3 seconds. No page refresh or redeployment when links are added.
- Protected read/write access using an `ADMIN_TOKEN` environment variable. Links stay behind the passphrase rather than being visible publicly.
- Add single links, paste multiple links at once, search and filter the library, copy URLs, and export to JSON or CSV.
- Duplicate detection and simple categorization.
- PostgreSQL persistence when `DATABASE_URL` is configured. Without a database, the server works in temporary **memory mode**, and data is lost on restart.

## Render setup

Deploy this repository as a **Render Web Service**, not a static site.

- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `ADMIN_TOKEN` (a long, secret passphrase; never commit it to GitHub)
- Environment variable: `DATABASE_URL` (recommended Render Postgres connection URL)

The app binds to Render's `PORT` automatically. `/health` reports whether storage is persistent or temporary.

The linked GitHub repository is currently **public**, so do not commit private link collections or credentials to the repository. The actual link collection is stored in the database or server memory, not in GitHub.

## Scope

This is a human/assistant-assisted link collection website. It does **not** autonomously browse for new URLs or monitor links without a separately configured and authorized worker. Its frontend updates automatically as new database records are inserted.

