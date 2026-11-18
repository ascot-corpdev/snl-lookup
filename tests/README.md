# Tests

The suites cover the site and the three Supabase functions. They run on every pull request (GitHub > Actions > **Tests**); a red check means something broke, and the run's **test-output** download has screenshots from the failing suite.

## Run them yourself

```bash
npm install
npx playwright install chromium
npm test
```

`npm test -- filings chat` runs only the suites whose file names contain those words. The function suites need [Deno](https://deno.com) and are skipped without it.

## What's here

| Path | What it covers |
| --- | --- |
| `web/*.test.cjs` | The site (`web/index.html`) in Chromium, against an in-memory stand-in for Supabase (`web/mock-supabase.js`) and faked function answers. Each suite also checks the 390px phone layout. |
| `functions/*_test.ts` | The functions under Deno, against stand-ins for S&P's API, Snowflake and Anthropic's API (`functions/helpers/`). Request splitting, paging, reading rows by header name, sign-in and token reuse, the one-a-second throttle and request counter, the "not set up yet" paths, background answers and the Claude tool loop. |
| `functions/e2e_test.ts`, `web/e2e.test.cjs` | One whole question, end to end on fixtures: the form filings of two made-up insurers in one state, and whether one of them files separate forms for two customer segments. The search, the documents with page citations, the comparison table and the export. |
| `functions/resilience_test.ts`, `functions/pages_test.ts` | What keeps an answer safe when things go wrong: limits, time running out, a failed save, oversized documents, clearing up. |
| `functions/migration_test.ts` | The migration keeps row-level security on and gives anonymous visitors nothing. It reads the SQL as text; to see it run, apply the migrations to a scratch Postgres database. |
| `scripts/*.test.mjs` | The login script and the company-list import against a local stand-in for Supabase, and the shell steps of the Pages and keep-awake workflows. |
| `scripts/worker.test.mjs`, `web/accesslogin.test.cjs` | The Cloudflare Access sign-in: the Worker checking Access's token (signature, audience, issuer, expiry) or `ctx.access`, admin and reader roles, finding or creating the Supabase login and profile, the minted token's claims and signature (HS256, ES256, RS256), and the page signing in, renewing the token, recovering a dropped token and signing out through Access, against made-up keys and a stand-in for Supabase. |
| `fixtures/` | Test data. **Every company, NAIC code, id, tracking number and filing text in it is made up.** |
| `out/` | Screenshots from the last run. Not committed. |

Nothing in the tests touches S&P, Snowflake, Anthropic or a live database, and nothing is billed.

## Rules for test data

The repository is public. Never put real insurers, real filings, real S&P data, credentials or real people in a test. Use made-up names like the ones in `fixtures/`.

## Adding a test

Copy the nearest suite, keep its `ok(name, condition, detail)` checks, and end with `console.log(`${pass} passed, ${fail} failed`)` and a non-zero exit code on failure; `run.mjs` picks up any `web/*.test.cjs`, `functions/*.ts` or `scripts/*.test.mjs` file. When a change is meant to alter behaviour that a test checks, update the test in the same pull request.
