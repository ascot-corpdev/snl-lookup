# SNL lookup

A small web app for Ascot's Strategy & Corporate Development team. It answers insurance questions from S&P Global Market Intelligence data.

- **Filings:** search S&P's SNL Insurance Product Filings (rate, rule and form filings) by company, state, type of insurance, filing type and date. See the rate impact and description, and open the filing's original document.
- **Ask:** type a question in plain English. Claude searches filings, reads the documents, and answers with page citations, its sources and a comparison table you can export to CSV or Excel.
- **Statutory:** direct and net premiums written by line and state, policyholder surplus, and loss, expense and combined ratios by NAIC company or group code, with peers side by side. This view is built and waiting: it goes live when the Snowflake secrets are set (step 7).

It is a standalone app with its own repository and its own Supabase project. It never stores or sends deal, banker or pipeline information. Claude sees only the question typed and what S&P returns.

House rules for anyone changing the code are in [.github/copilot-instructions.md](.github/copilot-instructions.md). Tests are described in [tests/README.md](tests/README.md).

## How it fits together

| Part | Where it runs | What it does |
| --- | --- | --- |
| `web/` | GitHub Pages | The site. One page, no build step. Holds only the Supabase address and publishable key. |
| `snl-filings` | Supabase Edge Function | Filing search, reference lists and documents from S&P's Physical Documents API. Holds the S&P API credentials. |
| `snl-chat` | Supabase Edge Function | Claude, with the filing search, filing documents and statutory data as tools. Holds the Anthropic key. |
| `snl-statutory` | Supabase Edge Function | Statutory financials from S&P's data on Snowflake. Holds the Snowflake credentials. |
| `supabase/migrations/0001_snl.sql` | Supabase Postgres | Logins and roles, saved S&P results, the S&P request counter, Claude answers in progress. |
| `scripts/logins.mjs` | Your computer | Creates logins. There is no self sign-up. |

Security in one paragraph: the repository is public and holds no secret. Every credential lives in Supabase secrets and is used only inside the functions. Each function checks the caller's login itself. Saved S&P data sits in Supabase tables that only signed-in logins can read and only the functions can write (row-level security is on everywhere, and anonymous visitors get nothing). Filing documents are never stored: they pass straight through to the browser, and the copies Claude reads are deleted from Anthropic when the answer finishes. If an answer is abandoned part-way, its copies are deleted the next time anyone opens the app or asks a question, once it has been idle for an hour. Finished answers (the question, the answer and its quotes) are kept in Supabase for 30 days, readable only by the login that asked.

## Setup (about 30 minutes)

The owner does these steps. Steps 5 to 7 can wait until each credential arrives; the app says "not set up yet" for whatever is missing and everything else works.

### 1. Supabase project

Use a new project of its own.

1. Create a project at [supabase.com](https://supabase.com). The free plan is enough to start (see [Supabase limits](#supabase-limits-that-matter) for when Pro is worth it; note the free plan allows two active projects).
2. **SQL editor:** paste and run `supabase/migrations/0001_snl.sql`.
3. **Authentication > Sign In / Providers > Email:** keep Email enabled and turn **off** "Allow new users to sign up". Logins are created only by the script.
4. **Project settings > API Keys:** note the **publishable key** (`sb_publishable_...`, safe for the website) and the **secret key** (`sb_secret_...`, only for the login script on your computer). The Project URL is under **Project settings > Data API** (`https://YOUR_PROJECT_REF.supabase.co`). Never put the secret key in the site or in GitHub.

### 2. Logins

On your computer, in a copy of this repository:

```bash
npm install
```

```bash
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co SUPABASE_SECRET_KEY=sb_secret_... npm run logins -- seed
```

This creates `corpdev1` and `corpdev2` and prints a password for each, once. Send each password privately. People can change their password after signing in.

More logins:

```bash
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co SUPABASE_SECRET_KEY=sb_secret_... npm run logins -- add USERNAME corpdev "Display name"
```

The role is `corpdev` (can also set up the statutory mapping) or `reader` (can search and ask, nothing else). `reset USERNAME`, `remove USERNAME` and `list` work the same way.

### 3. Deploy the three functions

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then:

```bash
supabase login
```

```bash
supabase link --project-ref YOUR_PROJECT_REF
```

```bash
supabase secrets set ALLOWED_ORIGIN=https://YOUR_GITHUB_ORG.github.io
```

```bash
supabase functions deploy snl-filings --no-verify-jwt
```

```bash
supabase functions deploy snl-statutory --no-verify-jwt
```

```bash
supabase functions deploy snl-chat --no-verify-jwt
```

`--no-verify-jwt` is safe: each function checks the caller's login itself and answers only signed-in logins. The three functions share code in `supabase/functions/_shared/`, so after a change there, deploy all three again.

### 4. GitHub Pages

1. **Settings > Pages > Build and deployment > Source:** GitHub Actions.
2. **Settings > Secrets and variables > Actions > Variables:** add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (and `USERNAME_DOMAIN` if you changed it for the login script). Use the publishable key, never the secret key.
3. Merge to `main`, or run the "Deploy site to GitHub Pages" workflow. The site appears at `https://YOUR_GITHUB_ORG.github.io/snl-lookup/`.

A merge to `main` is a deploy.

### 5. S&P filings API (when S&P sends API credentials)

The API needs S&P **API** credentials. A Capital IQ Pro website login does not work. Once S&P sends them:

```bash
supabase secrets set SPGMI_API_USERNAME=...
```

```bash
supabase secrets set SPGMI_API_PASSWORD=...
```

Type the real value in place of `...` in your own terminal. Never paste a password into a chat, an email or this repository. The command stays in your terminal's history; to avoid that, put the two lines in a file, run `supabase secrets set --env-file FILE`, and delete the file.

The app assumes a **trial** account's limits (500 requests an hour, 12,000 a day). On a production account (2,000 an hour, 48,000 a day):

```bash
supabase secrets set SPGMI_ACCOUNT=production
```

Functions read new secrets straight away; there is nothing to redeploy. Then run [the first live search](#the-first-live-search).

### 6. Claude

Create an API key at [platform.claude.com](https://platform.claude.com), then:

```bash
supabase secrets set ANTHROPIC_API_KEY=...
```

Only switch this on if your S&P licence allows sending this data to Anthropic. Optional settings:

```bash
supabase secrets set CLAUDE_MODEL=claude-opus-5-5
```

```bash
supabase secrets set CHAT_SLICE_SECONDS=360
```

`CLAUDE_MODEL` changes the model (the default is shown). Set `CHAT_SLICE_SECONDS=360` only on a paid Supabase plan (see [Supabase limits](#supabase-limits-that-matter)).

### 7. Statutory data on Snowflake (when S&P creates the reader account)

Snowflake's SQL API does not accept a username and password. It needs a key pair or a programmatic access token on a service user in the reader account S&P provides.

**With a key pair (preferred).** Make the pair on your computer:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
```

```bash
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

Send S&P the **public** key (`rsa_key.pub`) to attach to the service user. Keep `rsa_key.p8` private: it is ignored by git here, and it must never be emailed or committed. Then:

```bash
supabase secrets set SNOWFLAKE_ACCOUNT=... SNOWFLAKE_USER=... SNOWFLAKE_WAREHOUSE=...
```

```bash
supabase secrets set SNOWFLAKE_PRIVATE_KEY="$(cat rsa_key.p8)"
```

`SNOWFLAKE_ACCOUNT` is the account identifier S&P gives you (for example `orgname-accountname`), `SNOWFLAKE_USER` is the service user's login name, and `SNOWFLAKE_WAREHOUSE` is the warehouse S&P names (their guide calls it `XF_READER<client>_WH`).

**With a programmatic access token instead:** set `SNOWFLAKE_PAT=...` in place of `SNOWFLAKE_USER` and `SNOWFLAKE_PRIVATE_KEY`.

The role, database and schema default to the ones in S&P's Snowflake guide (`XF_SNOWFLAKE_READER_ROLE`, `MI_XPRESSCLOUD`, `XPRESSFEED`). Override them with `SNOWFLAKE_ROLE`, `SNOWFLAKE_DATABASE` and `SNOWFLAKE_SCHEMA` only if S&P says otherwise.

Then map the fields, once, signed in as a Corp Dev login:

1. Open **Statutory**, click **Field set-up**, then **List views**. It lists the views the account can see. Click a view to see its columns.
2. For each field the app lists (for example policyholder surplus), write which view holds it and which columns hold the NAIC company code, group code, year and value, in the mapping box. Click **Save mapping**.

S&P's documents do not give the view or column names for SNL Insurance Regulatory Data, so nothing is assumed in the code. The mapping is saved in Supabase and can be changed any time without touching the code. Listing views or columns wakes the Snowflake warehouse (see [costs](#what-each-action-costs)); each list is saved after the first time. An example of one field (the names here are placeholders, not S&P's):

```json
{ "fields": { "surplus": { "view": "VIEW_NAME", "entity": { "company": "NAIC_COMPANY_COLUMN", "group": "NAIC_GROUP_COLUMN", "name": "NAME_COLUMN" }, "year": "YEAR_COLUMN", "value": "VALUE_COLUMN", "scale": 1000 } } }
```

`scale` multiplies the stored value: 1000 when the view holds thousands of dollars, 100 when a ratio is held as a fraction. Fields by line or by state also name a `line` or `state` column. `where` adds fixed filters, such as `[{ "column": "COLUMN", "equals": "value" }]`.

### 8. Keep Supabase awake (optional, free plan only)

The free plan pauses a project after about a week with no activity. To prevent that, run `supabase/migrations/0002_keepalive.sql` in the **SQL editor**. The "Keep Supabase awake" workflow then calls it once a day. It returns only the time and reads no data. Skip this on a paid plan.

## The first live search

After step 5:

1. Sign in and open **Filings**. Click **Refresh lists**. This loads S&P's lists of states, types of insurance, filing types and statuses (4 S&P requests). **Check that FL is in the state list.** S&P's own example searches Florida, so it is probably covered; this is the confirmation.
2. Add a company by its S&P company id or institution id (see the next paragraph), choose Florida and a date range, and search.
3. Open a document from a result row.
4. Open **Ask** and type the question. Say in the question anything Claude can't know from the filings, for example which product is the private client one and which is middle market.

**Company ids.** S&P's filings API has no company search: every search needs S&P's own company id or institution id. The app remembers the name, NAIC code and ids of every company it sees in results, so after one search by id you can find that company by name. Getting the first ids is a question for S&P (see [unconfirmed](#what-is-still-unconfirmed)).

**If something fails,** the message on screen says what S&P answered and gives S&P's reference number. Quote that reference to S&P support.

## What each action costs

**S&P requests** (the limit is 1 a second; trial 500 an hour and 12,000 a day, production 2,000 and 48,000). The status strip shows today's and this hour's count.

| Action | S&P requests |
| --- | --- |
| Opening the app, looking up a saved company, opening a saved search | 0 |
| Signing in to S&P | 1, when a function starts fresh or S&P stops accepting the token |
| Loading the reference lists | 4 the first time, then saved for 30 days |
| A search | 1 for each batch of 10 companies, for each year of dates, for each 500 rows. Four companies over five years is 6. |
| The same search again | 0. It opens from the saved result until you click Refresh. |
| Opening a document | 1. The page keeps it until you close the tab. |
| Asking Claude | Whatever Claude looks up: the searches above plus 1 for each document it reads, and 2 the first time for the lists of insurance types and filing types if they aren't saved yet. One question is capped at 150 S&P requests, 24 lookups, 8 documents, 100 pages a document and 150 document pages in all. |

The app waits its turn so calls are at least a second apart, and stops with a plain message, before calling S&P, when the hour's or day's limit is used up. A search that would need more than 60 S&P requests (40 inside a Claude answer) is refused before any is spent, with the reason. A search with very many pages of results, or one where S&P answers slowly, stops early and says the results are incomplete; an incomplete result is never saved. Each login can have one Claude answer running at a time.

**Claude tokens** (billed to the Anthropic account whose key you set; Claude Opus 5.5 is $4 per million input tokens and $20 per million output tokens). These are estimates until the first live run:

- A question answered from search results alone: a few cents.
- A question that reads documents: Anthropic counts 1,500 to 3,000 text tokens a page plus an image of each page. Three filings of about 50 pages each is roughly 400,000 to 600,000 tokens, or about $2 to $3 for the answer. Later steps of the same answer re-read the documents from Anthropic's cache at a twentieth of the price.
- Each finished answer shows its token counts and S&P requests under the answer.

**Snowflake credits.** S&P's guide says an X-Small warehouse uses 1 credit an hour while it runs. Snowflake bills a minimum of one minute each time the warehouse wakes, so a statutory query (up to 8 short statements) costs about 0.02 credit, and Discover about the same. A repeated query opens from the saved result and costs nothing, whether it comes from the Statutory view or from Claude. In a reader account the provider (S&P) pays for credits; ask S&P whether use is capped or recharged.

**Supabase and GitHub Pages:** free at this size.

## Supabase limits that matter

From Supabase's documentation in November 2026.

| Limit | Free | Pro ($25 a month) | Why it matters here |
| --- | --- | --- | --- |
| How long one function call may run, background work included | 150 seconds | 400 seconds | A Claude answer runs in slices. Each reply from Claude must fit inside one call; a lookup asked for when the time is nearly up is put off to the next call. |
| CPU time per call | 2 seconds | 2 seconds | Fine: the functions mostly wait on S&P and Claude. |
| Memory | 256 MB | 256 MB | A filing document of up to 30 MB passes through. |
| Time to first response | 150 seconds | 150 seconds | A search is capped at 60 S&P requests to stay inside this. |
| Function calls a month | 500,000 | 2 million | Far above this app's use. |
| Database size | 500 MB | 8 GB | A saved search can be up to 4 MB (500 filings is about 0.4 MB). A result too big to save, about 5,000 filings or more, asks S&P again each time. |
| Pausing | After a week with no activity | Never | Step 8 keeps a free project awake. |
| Active projects | 2 | No fixed limit | This app needs a project of its own. |
| Log history | 1 day | 7 days | Useful when chasing an S&P error after the fact. |

**How long answers work.** A function call cannot run longer than the first row, and a background task does not extend it. So an answer saves its place after every step and pauses before the limit; the page then asks the function to carry on, and it picks up where it stopped. Keep the tab open while an answer runs. If a function call dies mid-step, the page notices within a minute and the next call starts again from the last saved place.

**When Pro is worth it:**

- Answers stop with "One step of this answer takes longer than Supabase lets a function run". That happens when a single reply from Claude takes more than about two minutes, most likely on questions that read several long filings. On Pro, set `CHAT_SLICE_SECONDS=360`.
- Answers often pause and carry on. Each pause costs up to a minute of waiting. Longer slices on Pro mean fewer pauses.
- You want a third project, or don't want to rely on the keep-awake workflow.
- You need more than a day of logs to diagnose a problem.

## What is still unconfirmed

Nothing in this list is guessed in the code: each item is either handled both ways, or kept behind one function marked `UNCONFIRMED`.

| What | Where it sits | Who confirms it |
| --- | --- | --- |
| **S&P API credentials.** The API does not accept a Capital IQ Pro website login. Nothing has run against the live API; every test uses made-up fixtures. | Step 5 | S&P |
| **The sign-in address and how long a token lasts.** The address comes from an S&P sample notebook, not the public API specification. The lifetime is not documented, so the app keeps the token and gets a new one after S&P rejects it. | `signIn` in `_shared/spgmi.ts` | First live call |
| **Florida coverage.** | The state list in step 1 of the first live search | First live call |
| **The columns of S&P's reference lists.** The specification does not give them. The app takes the first column ending in "Id" as the id and the next as the name, and keeps the raw rows. | `referenceOptions` in `_shared/filings.ts` | First live call |
| **Paging fields in search results** (`totalPages` and so on). They are in S&P's user guide but not the public specification. The app works with or without them. | `searchFilings` in `_shared/filings.ts` | First live call |
| **How to find a company's S&P company id or institution id**, and which identifiers these are in Capital IQ Pro. The filings API has no company search and cannot search by NAIC code. | `resolveEntity` in `_shared/filings.ts` | S&P |
| **Date and rate-impact formats** in results. The app shows what S&P sends and "n/d" when it is missing. | The Filings view | First live call |
| **How S&P counts requests**: whether sign-ins count, and when its day starts. The app counts every call and uses UTC days, so it can only over-count. S&P's public API specification also limits document downloads to 500 an hour on a trial account (1,000 in production); the app does not count those separately. | `makeGate` in `_shared/spgmi.ts` | S&P |
| **Ids are whole numbers and filters are lists.** S&P's specification gives no types; the app follows its examples (company, institution, status, type and filing type ids as numbers; states as two-letter codes). If a live reference list shows text ids, searches by that filter will be refused until this is changed. | `parseSearch` in `_shared/filings.ts` | First live call |
| **Pages of results are numbered from 1**, as in S&P's example. | `searchFilings` in `_shared/filings.ts` | First live call |
| **One filing version has one document, state and set of dates.** When several rows share a `filingVersionId`, the app keeps the first row and lists every company on it. | `dedupe` in `_shared/filings.ts` | First live call |
| **What `pages` means.** Taken as the document's page count. The app also counts the pages in the file and uses the larger number for Claude's limits. | `read` in `_shared/chat.ts` | First live answer |
| **What a `filingVersionId` looks like.** S&P's example is a 36-character id; the app passes on any id of 8 to 64 letters, digits, dots, underscores and dashes. | `parseDocRef` in `_shared/filings.ts` | First live call |
| **How S&P answers a wrong username or password.** A 400 or 401 from the sign-in address is shown as "sign-in refused". | `signIn` in `_shared/spgmi.ts` | First live call |
| **The unit of `overallRateImpact`.** Shown as a percentage when S&P's display value is missing. | The Filings view (`web/index.html`) | First live call |
| **How an account name with an underscore is written in the Snowflake sign-in token.** Snowflake's documentation does not say; the app keeps the underscore. | `jwtAccount` in `_shared/snowflake.ts` | First Snowflake call |
| **Whether S&P limits API access to fixed IP addresses.** Supabase functions do not have fixed addresses. | n/a | S&P |
| **The Snowflake reader account**: the account identifier, the service user with key-pair sign-in, and the warehouse name. | Step 7 | S&P |
| **Every SNL Insurance Regulatory view and column name.** | The mapping (step 7); `buildSql` in `_shared/statutory.ts` | Discover, then Corp Dev |
| **Who pays for Snowflake credits** and whether use is capped. | n/a | S&P |
| **Claude reading real filings.** Tested against a stand-in for Anthropic's API only. Watch the first live answer: the page citations, the cost and how long each step takes. | `_shared/chat.ts` | First live answer |

S&P's "SNL Insurance Product Filings User Guide" was not available when this was built. The code follows the summary of it in the build brief and S&P's public API specification.

## Running locally

Fill in `web/config.js` with the Project URL and publishable key (don't commit it), then:

```bash
npm run serve
```

Open http://localhost:8080. Add `http://localhost:8080` to `ALLOWED_ORIGIN`, separated from the site's address by a comma.

Run the tests (they need [Deno](https://deno.com) for the function suites):

```bash
npm test
```

## Notes

- **Saved results.** A search, a reference list or a statutory query is saved the first time and reopened from Supabase after that, with the date it was fetched. Refresh asks S&P again.
- **Empty results.** When S&P returns nothing for a state or a company, the app says exactly that. It never says no filings exist.
- **Documents.** Usually PDFs. Claude can read PDFs and plain text of up to 100 pages each; anything else opens from the Filings view. When S&P gives no page count, the app counts the pages in the file itself, and refuses a file over 5 MB whose pages it can't count.
- **Follow-up questions** in the same conversation carry the earlier questions and answers, not the documents. Claude re-reads a document if it needs it again (1 S&P request).
- **Bulk download** (the "API Drive" delivery in S&P's API specification) needs separate credentials and is not used.
- **One answer at a time.** A login with an answer in progress is asked to wait before asking another. If its tab was closed, a new question is accepted ten minutes later.
- **Housekeeping.** Finished answers are removed after 30 days, and leftovers from abandoned answers are cleared whenever someone opens the app.
