# Working on SNL lookup

SNL lookup is a small web app for Ascot's Strategy & Corporate Development team. It answers insurance questions from S&P Global Market Intelligence data: filing search and filing documents (S&P's Physical Documents API), statutory financials (S&P's data on Snowflake), and Claude on top with those as tools. Read `README.md` first.

## How it is built

- **Site:** `web/index.html`, one file with inline CSS and JavaScript. There's no framework, bundler or build step. GitHub Pages serves `web/` as is. `web/config.js` is blank in the repo; the Pages workflow writes it from repository variables.
- **Functions:** three Supabase Edge Functions in Deno (`supabase/functions/snl-filings`, `snl-statutory`, `snl-chat`) with shared code in `supabase/functions/_shared/`. They hold every credential. Each checks the caller's login itself, so they are deployed with `--no-verify-jwt`.
- **Database:** `supabase/migrations/0001_snl.sql`. Logins and roles (`profiles`), saved S&P results (`snl_store`), the S&P request counter and throttle (`snl_usage`, `snl_take_slot`), Claude answers in progress (`snl_jobs`, `snl_job_state`), shared settings (`snl_settings`).
- **Logins:** `scripts/logins.mjs`. No self sign-up.
- **Tests:** `npm test`. See `tests/README.md`.

## Rules

- **The repository is public.** Never commit S&P documents or schema files, real query results or filing documents, credentials, or anyone's contact details. Test fixtures use made-up company names, NAIC codes, ids and filing text, in the shapes S&P's documents describe.
- **Never** put secrets in the repo, the page or a commit. The publishable key is the only key the site uses. Never ask anyone to paste a password, key or token into a chat; give the owner the `supabase secrets set NAME=...` command with `...` in place of the value.
- **No deal data.** This app never stores or sends Ascot deal, banker or pipeline information. Claude sees only the user's question and what S&P returns.
- **No invented schema or endpoints.** Anything S&P's documents don't confirm stays behind one function marked `UNCONFIRMED` and is listed in the README under "What is still unconfirmed".
- **An empty result is not "no filings exist".** Say that S&P returned nothing for that search.
- Work on a branch and open a pull request; merging to `main` publishes the site.
- Database changes go in a new numbered migration that is safe to run once, keeps RLS on, and revokes access from `anon`. Don't edit migrations that have already been run.
- **Libraries:** only from CDNs with exact versions. Function imports are `npm:` specifiers pinned to exact versions. Don't add a build step or npm packages to the site.
- Keep the phone layout working: no sideways scroll at 390px wide.
- Writing on the page follows the Ascot house style: plain English, sentence case, "n/d" for missing numbers, $M with commas, dates like "5 Nov" (year added when it isn't the current year).
- Anything from the database, a function or a user goes through `esc()` before it is put into HTML. The page builds no link from data; if one is ever added, check its address first.
- Every behaviour gets a test. If a change is meant to alter something a test checks, update that test in the same pull request. Never weaken or delete a check just to get it green.
- No model identifiers in commit messages or pull request text. A model id appears only as a configuration value in code.

## What needs the owner

Creating the Supabase project, setting secrets, running migrations, deploying functions, creating logins and anything that uses real S&P credentials. Write the code, then give the owner the exact commands. Migrations are pasted into **Supabase > SQL editor** and run.
