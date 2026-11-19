# SNL lookup

A small web app for a Strategy & Corporate Development team at an insurer. It answers insurance questions from S&P Global Market Intelligence data.

- **Filings:** search S&P's SNL Insurance Product Filings (rate, rule and form filings) by company, state, type of insurance, filing type and date. See the rate impact and description, and open the filing's original document. States are chosen on a map of the United States or from the list beside it.
- **Snapshot:** pick one company or a whole group and the last 1, 3 or 5 years, and see its filings on one page: headline counts, a map by state, rate changes over time, filings by year and type, the latest form and rule filings, and the approximate time with the regulator. It is worked out in the browser from one ordinary filings search, which is saved, so reopening a snapshot costs nothing.
- **Ask Claude:** a panel that opens over either view. Type a question in plain English. Claude is told what is on your screen (the filings search or the statutory figures), searches filings, reads the documents, and answers with page citations, its sources and a comparison table you can export to CSV or Excel. Under every finished answer, **Export answer** downloads the question, answer, table and numbered sources as one Word document, and **Copy answer** copies the same so it pastes into an email or a memo with the table intact. The panel also lists your own questions from the last 30 days under "Past answers".
- **Statutory:** direct and net premiums written by line and state, policyholder surplus, and loss, expense and combined ratios by NAIC company or group code, with peers side by side. This view is built and waiting: it goes live when the Snowflake secrets are set (step 7).

It is a standalone app with its own repository and its own Supabase project. It never stores or sends deal, banker or pipeline information. Claude sees only the question typed and what S&P returns.

House rules for anyone changing the code are in [.github/copilot-instructions.md](.github/copilot-instructions.md). Tests are described in [tests/README.md](tests/README.md).

## How it fits together

| Part | Where it runs | What it does |
| --- | --- | --- |
| `web/` | GitHub Pages | The site. One page, no build step. Holds only the Supabase address and publishable key. |
| `worker/`, `wrangler.toml` | Cloudflare Worker | Optional, recommended (step 4a). Serves the same site at a `workers.dev` address behind Cloudflare Access, and is then the only way to a Supabase session. Holds no secrets. |
| `snl-signin` | Supabase Edge Function | Optional (step 4a). Checks a Cloudflare sign-in itself and turns it into a one-hour Supabase session for that person. |
| `snl-filings` | Supabase Edge Function | Filing search, reference lists and documents from S&P's Physical Documents API. Holds the S&P API credentials. |
| `snl-chat` | Supabase Edge Function | Claude, with the filing search, filing documents and statutory data as tools. Holds the Anthropic key. |
| `snl-statutory` | Supabase Edge Function | Statutory financials from S&P's data on Snowflake. Holds the Snowflake credentials. |
| `snl-watch` | Supabase Edge Function | Optional. The daily watchlist check: new filings for the companies and states the team follows. |
| `snl-profile` | Supabase Edge Function | Optional. The figures and the text for a company profile. |
| `snl-digest` | Supabase Edge Function | Optional. Filing summaries: made once, saved, and searched. |
| `snl-index` | Supabase Edge Function | Optional. The market index: sweeps a state for every listed company and answers from what it kept. |
| `web/deck.js`, `web/profile-slides.js` | The browser | Build the profile as a PowerPoint file on your template. The file is made in the browser and never stored on the server. |
| `supabase/migrations/0001_snl.sql` | Supabase Postgres | Logins and roles, saved S&P results, the S&P request counter, Claude answers in progress. |
| `supabase/migrations/0003_watchlist.sql` | Supabase Postgres | Optional. The filings the watchlist found and the record of its checks. |
| `supabase/migrations/0004_profile_template.sql` | Supabase Storage | Optional. A private place for the PowerPoint template. |
| `supabase/migrations/0005_filing_digests.sql` | Supabase Postgres | Optional. Saved filing summaries. |
| `supabase/migrations/0006_market_index.sql` | Supabase Postgres | Optional. The market index and the record of its sweeps. |
| `supabase/migrations/0007_answer_library.sql` | Supabase Postgres | Optional. The team library of saved answers. |
| `supabase/migrations/0008_own_templates.sql` | Supabase Storage | Optional. Lets each login keep one PowerPoint template of their own, private to them. |
| `supabase/migrations/0009_market_filters.sql` | Supabase Postgres | Optional. Lets the market index answer for several states and types of insurance at once. |
| `supabase/migrations/0010_market_more_filters.sql` | Supabase Postgres | Optional. Lets the market index answer for several filing types and statuses at once. |
| `scripts/logins.mjs` | Your computer | Creates logins. There is no self sign-up. |
| `scripts/companies.mjs` | Your computer | Loads a company list so companies can be found by name or NAIC code. |

Security in one paragraph: the repository is public and holds no secret. Every credential lives in Supabase secrets and is used only inside the functions. Each function checks the caller's login itself. Saved S&P data sits in Supabase tables that only signed-in logins can read and only the functions can write (row-level security is on everywhere, and anonymous visitors get nothing). Filing documents are never stored: they pass straight through to the browser, and the copies Claude reads are deleted from Anthropic when the answer finishes. If an answer is abandoned part-way, its copies are deleted the next time anyone opens the app or asks a question, once it has been idle for an hour. Finished answers (the question, the answer and its quotes) are kept in Supabase for 30 days, readable only by the login that asked.

## Setup (about 30 minutes)

The owner does these steps. Step 7 can wait until the Snowflake account arrives; the app says "not set up yet" for whatever is missing and everything else works.

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

### 2a. Load a company list (optional, recommended)

S&P's filings search needs S&P's own company id or institution id for every company, and it has no search by name. Loading a list once lets everyone find a company, or a whole group, by name or NAIC code.

1. Export the list from S&P Capital IQ Pro with these columns where you have them: company name, S&P company id, institution id, NAIC company code, NAIC group code and group name. It needs the name and at least one of: an S&P company id, an institution id, or a NAIC company code. A NAIC code alone is enough to be useful: on the Statutory view people can type part of a company or group name, pick from the matches and add a whole group at once, instead of remembering NAIC codes. Companies with an S&P id can also be found by name on the Filings view; companies with only a NAIC code show there but can't be searched for filings.
2. Save it as a CSV (in Excel: **File > Save As > CSV UTF-8**). S&P's own export headings, such as "S&P Institution Key" and "S&P Statutory Entity Key", are recognised without any options. Keep the file out of this repository: it may be S&P's data, and `.csv` files are ignored by git here for that reason.
3. See what would be loaded. This changes nothing and needs no key:

```bash
npm run companies -- check PATH/TO/LIST.csv
```

It prints which column it took for each field and the first three companies. If it picked the wrong column, name it yourself, for example `--company-id "Your heading"` (the full list of options is at the top of `scripts/companies.mjs`).

4. Load it, with the same address and secret key as for logins:

```bash
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co SUPABASE_SECRET_KEY=sb_secret_... npm run companies -- load PATH/TO/LIST.csv
```

Loading again updates companies in place. A company the app has already seen in search results is merged into one row with everything both know (S&P ids, NAIC code, group), and any second row of the same company is merged in and removed. On the Filings view, type a group name and click **Add all** to search the whole group at once (up to 100 companies a search).

To check the list, and to merge any company saved twice before this was so (this shows what it would do and changes nothing):

```bash
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co SUPABASE_SECRET_KEY=sb_secret_... npm run companies -- tidy
```

If it lists any, run it again with `-- tidy --apply`.

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
2. **Settings > Secrets and variables > Actions > Variables:** add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (and `USERNAME_DOMAIN` if you changed it for the login script). Use the publishable key, never the secret key. Optionally add `ORG_NAME`, the company name the site shows in the browser tab, the footer and the Ask Claude panel; without it the site names no company.
3. Merge to `main`, or run the "Deploy site to GitHub Pages" workflow. The site appears at `https://YOUR_GITHUB_ORG.github.io/snl-lookup/`.

A merge to `main` is a deploy.

### 4a. Cloudflare sign-on (optional, recommended: replaces usernames and passwords)

The site is served by a Cloudflare Worker at `https://snl-lookup.YOUR_SUBDOMAIN.workers.dev`, behind Cloudflare Access. Colleagues sign in with a one-time code Cloudflare emails them. The owner can sign in with their Cloudflare account. Nobody needs a username or a password, and no login is made by a script.

How it works:

- **Cloudflare decides who comes in.** The list of email addresses is the Access policy. The Worker checks Cloudflare's signed sign-in on every request and serves nothing without it, including when Access is switched off.
- **The back end is tied to the same sign-in.** A sign-in page in front of a static site protects nothing behind it, because the page talks straight to Supabase. So the page asks the Worker for a session, the Worker passes the Cloudflare sign-in to `snl-signin`, and `snl-signin` checks it again against Cloudflare's own keys before it gives out a Supabase token. Row-level security, each function's own login check and the storage rules are unchanged.
- **The token lasts about an hour and cannot renew itself.** No refresh token ever leaves Supabase. The page comes back through Cloudflare for a new token before the old one ends.
- **`SNL_ADMIN_EMAILS` decides who is Corp Dev.** Everyone else Cloudflare lets in is a reader. The role follows that list at every sign-in, up and down.
- **Usernames** are the part of the address before the @ (`jane.doe`), with `-2`, `-3` when taken. The email address is shown in the account menu.

The GitHub Pages copy keeps working with usernames and passwords until you retire them (the last step), so nothing breaks while you switch over.

**1. Deploy the Worker.** From the repository root. Until its settings exist it answers 403 to everyone.

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

**2. Switch on Access for its address.** Cloudflare dashboard > Workers & Pages > snl-lookup > Access > protect this Worker behind Access, for all traffic. The dashboard's wording may differ slightly.

**3. Set who may come in.** In Zero Trust:

1. Integrations > Identity providers: check **Cloudflare** is listed with "Restrict to account members" on, and add **One-time PIN**.
2. Access controls > Applications > the snl-lookup application > Edit: add an Allow policy that includes your colleagues' email addresses, and tick both login methods.
3. Copy the **Application Audience (AUD) tag** from the application's additional settings. Your team domain is `YOUR_TEAM.cloudflareaccess.com`: the address of the Cloudflare sign-in page shows it.
4. Ask colleagues to allow mail from `noreply@notify.cloudflare.com`, which sends the codes.

Keep "Restrict to account members" on. If the Cloudflare account has other members, they can come in as readers.

**4. Set the Worker's settings.** Each command asks for the value. None is a secret, but none is committed, because the repository is public. A deploy never removes them. `ORG_NAME` is optional.

```bash
npx wrangler secret put TEAM_DOMAIN
```

```bash
npx wrangler secret put POLICY_AUD
```

```bash
npx wrangler secret put SUPABASE_URL
```

```bash
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
```

```bash
npx wrangler secret put ORG_NAME
```

`TEAM_DOMAIN` is `YOUR_TEAM.cloudflareaccess.com`; the team name alone, or the sign-in page's whole address, is also accepted. Use the publishable key, never the secret key. A secret key set here by mistake is refused and never sent to a browser. If the site answers "Not set up yet", the page says which of `TEAM_DOMAIN` and `POLICY_AUD` is missing or in the wrong form; `npx wrangler secret list` shows which settings exist.

**5. Set the Supabase secrets.** `SNL_ADMIN_EMAILS` is a comma-separated list; for the owner it is the email address of their Cloudflare account.

```bash
supabase secrets set CF_ACCESS_TEAM_DOMAIN=YOUR_TEAM.cloudflareaccess.com
```

```bash
supabase secrets set CF_ACCESS_AUD=...
```

```bash
supabase secrets set SNL_ADMIN_EMAILS=...
```

**6. Deploy `snl-signin`.** Authentication > Sign In / Providers > Email must stay on (the session is made through a sign-in link that is never sent). "Allow new users to sign up" can stay off.

```bash
supabase functions deploy snl-signin --no-verify-jwt
```

**7. Let the page call the functions from the new address.** Keep both addresses while you switch over.

```bash
supabase secrets set ALLOWED_ORIGIN=https://YOUR_GITHUB_ORG.github.io,https://snl-lookup.YOUR_SUBDOMAIN.workers.dev
```

**8. Keep your history.** Past answers, recent searches and saved things belong to your existing login. Point it at your real email address before your first Cloudflare sign-in, so that sign-in lands on the same login. Do the same for any colleague whose history should be kept. The `logins` commands here need `SUPABASE_URL` and `SUPABASE_SECRET_KEY` set as in step 2.

```bash
npm run logins -- link YOUR_USERNAME YOUR_EMAIL
```

**9. First sign-in.** Open the `workers.dev` address and sign in. The account menu should show your email address and "Corp Dev". This first sign-in is the live check of everything above.

**10. Retire the passwords**, once everyone has signed in through Cloudflare. The first command only lists what it would do.

```bash
npm run logins -- retire-passwords
```

```bash
npm run logins -- retire-passwords --apply
```

```bash
supabase secrets set ALLOWED_ORIGIN=https://snl-lookup.YOUR_SUBDOMAIN.workers.dev
```

Then run `delete from auth.sessions;` once in the SQL editor: it ends any password session still open, and people on Cloudflare are signed in again by themselves. Optionally switch GitHub Pages off (Settings > Pages). After this, the only way to get a session is `snl-signin`, which gives one only for a sign-in Cloudflare signed for this application.

**Adding a person:** add their email address to the Access policy. Their login and profile are made at their first sign-in.

**Removing a person:** remove their address from the Access policy, then Zero Trust > Team & Resources > Users > select them > Revoke. The token already in their browser lasts until it expires, one hour by default (Supabase's Auth settings set the access token expiry; Supabase advises no less than 5 minutes). For an immediate cut-off, also run `npm run logins -- remove THEIR_USERNAME`.

**Deploying the site** on this route is `npx wrangler deploy` again after a `git pull`. A merge to `main` deploys only the GitHub Pages copy.

**Cost.** Free at this size: Cloudflare's free Workers plan allows 100,000 requests a day, and Zero Trust is free for up to 50 users. Cloudflare describes `workers.dev` addresses as meant for projects that are not business-critical and recommends a custom domain for production.

### 5. S&P filings API

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

Functions read new secrets straight away; there is nothing to redeploy.

**Check the S&P connection first.** Sign in to the site and click **Check S&P connection** at the right of the grey strip under the tabs. In a few seconds it signs in to S&P, checks the account can use SNL Insurance Product Filings, and loads the lists of states, types of insurance, filing types and statuses (at most five S&P requests). Each step says Done or Failed. If anything failed, click **Copy for S&P** and paste the text into an email to S&P support: it says what failed and gives S&P's reference number where S&P sent one. If S&P has locked the API account, ask S&P to unlock it. The app stops signing in for 30 minutes after a lock so it can't make the lock worse, and for 5 minutes after a refused password unless the password is changed.

**Live check (Corp Dev logins).** Click **Live check** next to Check S&P connection. In about a minute it looks at your recent saved searches, the company list and a few real S&P answers (at most six S&P requests: a sign-in, one small search and one document, plus any missing list), and says for each thing the app assumes about S&P's data whether it holds or differs. The report holds no S&P data, only column names, value types, counts, shares and patterns, so it is safe to send. Click **Copy for developer** and paste it into a message to whoever maintains the app. It saves nothing except reference lists it had to fetch, and it never sends a wrong password, so it can't lock the account. It skips S&P when fewer than 20 requests are left in the hour or day.

Then run [the first live search](#the-first-live-search).

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

```bash
supabase secrets set ORG_NAME=...
```

`ORG_NAME` is the company name Claude is told it works for; without it Claude is told it works for an insurer's team. `CLAUDE_MODEL` changes the model (the default is shown). Set `CHAT_SLICE_SECONDS=360` only on a paid Supabase plan (see [Supabase limits](#supabase-limits-that-matter)).

Each login can ask 40 questions a day, counted from midnight UTC. To change that (0 means no limit):

```bash
supabase secrets set CHAT_DAILY_LIMIT=40
```

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

### 9. Watchlist (optional)

Name the companies and states the team follows once; a daily check shows any new rate, rule or form filing on the Filings view, and can email it. Until each step below is done, the watchlist card on the Filings view says which one is missing.

The watchlist is visible to every login on the site and is kept in your Supabase project. It names companies the team follows, so decide whether a name belongs on it before adding it.

1. **SQL editor:** run `supabase/migrations/0003_watchlist.sql`. It stores the filings found and the record of checks for 90 days. Logins can read them; only the function writes.
2. Set the secret the daily schedule sends. Use any long random string (at least 24 characters) and keep a copy for step 4.

   ```bash
   supabase secrets set WATCH_SECRET=...
   ```

   Optional, to email new filings to the recipients set on the page. You need a Resend account with your sending domain verified:

   ```bash
   supabase secrets set RESEND_API_KEY=...
   ```

   ```bash
   supabase secrets set WATCH_FROM="SNL lookup <watch@yourco.com>"
   ```

   ```bash
   supabase secrets set SITE_URL=https://YOUR_GITHUB_USER.github.io/REPO_NAME/
   ```

   `RESEND_API_KEY` is optional: without it the Filings view still shows everything. Without `WATCH_FROM`, Resend only delivers to the Resend account's own address. Without `SITE_URL`, the email links to the first address in `ALLOWED_ORIGIN`.
3. Deploy the function. `--no-verify-jwt` is safe: it checks the login, or the secret, itself.

   ```bash
   supabase functions deploy snl-watch --no-verify-jwt
   ```

4. **SQL editor:** open `supabase/watch_schedule.sql`, replace `YOUR_PROJECT_REF` and `YOUR_WATCH_SECRET` (the same value as `WATCH_SECRET`), and run it. It checks every day at 06:23 UTC. Don't commit the file with your values in it.

On the site, a Corp Dev login chooses companies and states in the search form and clicks **Manage**, then **Add the companies and states chosen below**. Then click **Check now** once: this first check records what is already there as the starting point, so the next daily check shows only what is new. Run `supabase/watch_schedule.sql` only once; to change the secret later, use the line at the end of that file.

**What a check costs.** Each check asks S&P for filings published in the last 14 days. It uses one S&P request for every 10 company ids, one for every 10 institution ids, and up to 2 more (the sign-in and S&P's list of filing statuses, often reused), plus one for each extra page of results. For example, 25 companies by company id and 3 by institution id cost 3 + 1 + 2 = 6 requests a day, about 180 a month. A check may use at most 30 requests, so it covers up to 280 companies. A bigger watchlist is refused before any request is spent, with how many companies to remove. Checks go through the same one-a-second throttle and hourly and daily counter as every other S&P call.

**The first check only records a starting point.** A filing counts as new only if its company and state were already covered by the last complete check, so adding a company never floods the list.

**Marks.** Some new filings carry a mark such as *New program*, *New to state*, *New form*, *Withdrawal* or *Large rate change* (10% or more either way). Marked filings are listed first, and a button shows only those. A mark is a hint worked out from the filing type, status, rate impact and description, never a fact: the page and the email say "may be" and show the words or figures that triggered it. A filing without a mark can still matter. Changing the rules re-marks every kept filing; no database change is needed.

**After a gap.** If the last complete check was more than 3 days ago (switched off, failing, or Supabase paused), the next check looks back to 14 days before it, up to 60 days, so filings published in the gap are still found. This uses no extra S&P requests beyond extra pages of results.

**Email.** The email gives each new filing's company, state, filing type, one line of description, tracking number and any mark, marked ones first, with a link to the app. Without email, the Filings view shows the same information.

### 10. Company profiles (optional)

The **Profile** view builds a company profile as a PowerPoint file on your team's own template, with charts and tables you can edit: cover, executive summary, premium, underwriting, capital, reserves, reinsurance, recent rate and form filings, and key diligence questions. The template is kept in private storage, never in this repository. A built profile is made in the browser and is never stored on the server.

1. **SQL editor:** run `supabase/migrations/0004_profile_template.sql`. It adds a private storage bucket for the template. Any login can read it; only Corp Dev logins can change it.
2. Deploy the function:

   ```bash
   supabase functions deploy snl-profile --no-verify-jwt
   ```

   The profile adds statutory fields the other functions also list, so deploy `snl-statutory` and `snl-chat` again too (step 3).

3. Optional: sign in with a Corp Dev login, open **Profile** and choose **Upload the standard template** (.pptx, up to 50 MB). Until one is uploaded, decks are built on the site's built-in plain template (`web/template-builtin.pptx`). The page checks every file before it uploads it: it must be widescreen, with a cover layout named "Title White" and a content layout named "Spectrum Title Only White".
4. Choose **Build a sample profile** to see how your template comes out. The sample uses made-up figures, so it works before statutory data is set up. Open the file in PowerPoint and check the slides before relying on the builder.
5. When Snowflake is set up, map the extra statutory fields on **Statutory > Field set-up**, as in step 7: gross premiums written, net premiums earned, net income, paid-in capital, total assets, risk-based capital ratio, net loss and LAE reserves, prior-year reserve development, reinsurance recoverables, and ceded premiums by reinsurer. The last of these also names an `item` column, the reinsurer's name. A slide whose figures aren't mapped is left out, and the page says why.
6. Find a company or group, choose **Get figures** to see which slides it fills, then build the file.

**Which template a deck is built on.** The first of these that exists: a file chosen "just this once" (kept in memory, never stored), your own template, the standard template Corp Dev uploaded, the built-in plain template. The Profile view says which one the next deck will use, and the "ready" message names it.

**Templates of your own.** Anyone can upload a template that only they use (up to 20 MB), replace it, or remove it to go back to the standard one. Nobody else can see or use it, Corp Dev included. To switch this on, run `supabase/migrations/0008_own_templates.sql` in the **SQL editor**, after step 1. Until it is run, decks keep working on the standard or built-in template and "Upload your own" says what is needed. If you ever run 0004 again, run 0008 again after it. When a login is removed, its template stays in storage: in the Supabase dashboard open **Storage > snl-template**, open the folder named with that login's user id (shown under **Authentication > Users**) and delete it.

**The text on the slides.** With an Anthropic key set, Claude drafts the slide titles, takeaways and diligence questions from that company's figures only. The function checks every figure Claude writes against the data; a section with a figure it can't match is replaced with plain text, and the page says so. A draft counts as one of the login's questions for the day (`CHAT_DAILY_LIMIT`) and appears in Past answers. Without a key, the slides use plain text. Read the drafted text before you use it: it is a first draft, and judgements are marked "(inferred)".

**What a profile leaves out on purpose.** No comparisons with past deals, no teaser claims, no ownership or management pages: the app holds no deal information and only S&P's data. Add those in PowerPoint.

**A filings profile, from S&P's filings alone.** While statutory data isn't set up, the Profile view opens on **Filings profile**. Find a company or a whole group by name, choose the last year, 3 years or 5 years, and choose **Get the filings**. The page shows what it will cost and which slides it fills, then builds the deck on your template: summary, rate changes, where it files, filings by year and type, latest form and rule filings, time with the regulator, and diligence questions. Rate impacts are S&P's overall figure for each filing, not weighted by premium; for a filing that isn't approved, the figure may be the change asked for. Use **Build a sample filings profile** to check your template with made-up filings. It needs steps 1 and 2 above and nothing else.

**What the filings profile adds when it can.** Two US maps drawn as shapes you can recolour in PowerPoint: filings by state, and the latest rate change by state. A state where S&P returned nothing is hatched, never shown as zero. Where saved filing summaries exist (step 11): the premium and policyholders each rate filing states for the book it covers, which is not statutory premium; rate adequacy and loss costs (indicated against filed against approved change, loss cost multiplier and reference, trend, loss ratio, expense and profit assumptions); and programs and forms. Every such figure carries its filing number and page. Where the market index (step 12) covers a state the company files in, one slide sets the company against the index. A slide that can't be filled is left out, and the page says why and what it would cost to include.

**Summarise before building.** After **Get the filings** the page shows how many of the company's rate and form filings already have a saved summary, and offers to summarise the latest ones (5 rate and 3 form filings by default, up to 10 of each). The cost is shown first: each summary is 1 S&P request, about $2.30 to $3.50 of Claude reading and one of the day's questions, so the default is about $18 to $28. Saved summaries are free. Summaries made before this version don't hold the loss cost and adequacy figures; the profile counts them as older and offers to make them again. A summary reads up to 150 pages, and these figures often sit in later exhibits, so some filings will show "n/d". After updating, deploy `snl-profile` and `snl-digest` again.

### 11. Filing summaries (optional)

A filing is read by Claude once and its facts are saved: a short summary, the programs it names, its form schedule and its rate figures, each with the page it came from. Later questions are answered from the summary instead of paying to read the document again. Summaries are made in two ways: automatically after an Ask Claude answer that read a filing (from the same reading, for roughly $0.25 to $0.45), or with **Summarise this filing** on a Filings row (1 S&P request and one of the day's questions; about $2.50 for 150 pages). A long filing is summarised from its first 150 pages, and the summary says so. **Search saved summaries** on the Filings view finds them by form number or phrase at no cost.

1. **SQL editor:** run `supabase/migrations/0005_filing_digests.sql`.
2. Deploy the new function, and the questions function again:

   ```bash
   supabase functions deploy snl-digest --no-verify-jwt
   ```

   ```bash
   supabase functions deploy snl-chat --no-verify-jwt
   ```

**Programs and forms** (Compare tab, second page) uses these summaries: choose two to four carriers, a state and a type of insurance, and it lists each carrier's form filings, summarises the ones you choose, and sets out programs, form numbers and editions side by side, each with its filing and page. Nothing is summarised until you choose, and the page states the cost first. Until step 2 is done it still lists filings and opens documents.

### 12. Market index (optional)

S&P's filings search always needs companies named, so it cannot answer "who filed homeowners forms in Florida this year". The market index sweeps a chosen state for every company in your company list and keeps the filing details in your own database. After that the **Market** tab searches all of them at no S&P cost, and Claude asks the index first for a market question in a state it covers. Every answer says what the index covers: the state, the period, when the sweep last completed, and how many companies it did and did not cover. It is the companies in your list, not the whole market.

1. **SQL editor:** run `supabase/migrations/0006_market_index.sql`, then `supabase/migrations/0009_market_filters.sql`. The second lets the Market view ask for several states and several types of insurance in one search, each state answered over what its own sweep covers. Then run `supabase/migrations/0010_market_more_filters.sql`, which lets the Market view choose several filing types and statuses from the names the index holds, each matched by its whole name (so "Approved" no longer matches "Disapproved"). All three are safe to run twice; if 0006 or 0009 is ever run again, run the later ones again after it. Without 0009, one state and one type work as before and a wider question is refused with a message saying what to run. Without 0010, the Market view keeps its single Filing type and Status boxes.
2. Deploy the new function, and the questions function again:

   ```bash
   supabase functions deploy snl-index --no-verify-jwt
   ```

   ```bash
   supabase functions deploy snl-chat --no-verify-jwt
   ```

3. On the site, a Corp Dev login opens **Market**, chooses a state and a period and starts a sweep. The page shows the cost before it starts and carries the sweep on while it is open; closing the tab pauses it without losing work.
4. Optional, to keep sweeping with the page closed and to top a state up: set a secret of at least 24 characters, different from `WATCH_SECRET`, then open `supabase/index_schedule.sql`, replace `YOUR_PROJECT_REF` and `YOUR_INDEX_SECRET`, and run it in the SQL editor.

   ```bash
   supabase secrets set INDEX_SECRET=...
   ```

   `INDEX_TOPUP_DAYS` (default 7; 0 for none) sets how often a state is topped up.

**What a sweep costs.** One request covers 10 companies and up to 365 days. With about 2,700 companies, one state for one year is about 300 S&P requests and six minutes; three years is about 900. A top-up costs about the same as a one-year sweep, so weekly or monthly is the right rhythm, not daily. Sweeps leave the last 150 requests of each hour and 3,000 of each day for people using the site, and wait when they reach that. Storage is about 0.6 KB a filing: one state for one year is roughly 5 to 12 MB, and all 50 states for three years would not fit the free 500 MB plan.

### 13. Team library (optional)

Anyone can save one of their own finished answers from Claude where every login can read it. Before saving, the page says plainly that everyone with a login will be able to read the question and its answer, including which companies it is about. Saved answers stay until the person who saved them, or Corp Dev, removes them; the 30-day clean-up of answers does not touch them. The library holds at most 500 answers.

1. **SQL editor:** run `supabase/migrations/0007_answer_library.sql`.
2. Redeploy the questions function:

   ```bash
   supabase functions deploy snl-chat --no-verify-jwt
   ```

### Needing no set-up

- **Narrow it down.** Snapshot, Compare, Market and the filings profile each take four optional filters: states, type of insurance, filing type and filing status. With no status chosen, every status in S&P's list is searched. A section that depends on a filing type or status the narrowing excluded says it was left out by the narrowing, and never shows a zero or "S&P returned nothing": narrowed to rate filings, the form and rule figures say "Left out", and a profile deck leaves those slides out with the reason. Programs and forms takes a status filter too. Chosen before a search, they are what S&P (or the index) is asked for. On Snapshot and Compare the same filters also narrow what is on screen after a search, at once and without asking S&P again, with "Show everything" to undo it. Every heading, note, export and deck slide says what it was narrowed to, and an empty result says it shows nothing about other states or types. Narrowing does not reduce the number of S&P requests, which depends on companies and years; it reduces how many filings come back. After updating, deploy `snl-profile` and `snl-index` again. Several states or types at once on the Market view also needs `0009_market_filters.sql`, and its filing type and status lists need `0010_market_more_filters.sql` (step 12).
- **Compare** (tab): two to eight carriers, each a company or a whole group, side by side over the last 1, 3 or 5 years: a summary table, rate changes over time, carrier by state and by type of insurance, filings by year and the latest filings. Worked out in the browser from ordinary filing searches. A comparison of more than 100 companies runs as several searches, and one comparison may use at most 150 S&P requests.
- **Carrier sets.** Corp Dev logins save named sets of companies and whole groups from the **Carrier sets** button beside the company pickers. Every login can see and use them on the Filings form, the Snapshot, Compare, Programs and forms and the watchlist, and Claude checks a matching saved set instead of choosing carriers itself. Sets are visible to every login, so a set shows which companies the team follows. A group is kept by name and expanded to its member companies each time the set is used.
- **Ask about a Snapshot.** "Ask Claude about this" on a finished Snapshot writes a question from what is on screen and puts it in the box; nothing is sent until you press Ask.

## The first live search

After step 5:

1. Sign in and open **Filings**. Click **Refresh lists**. This loads S&P's lists of states, types of insurance, filing types and statuses (4 S&P requests). **Check that FL is in the state list.** S&P's own example searches Florida, so it is probably covered; this is the confirmation.
2. Add a company by its S&P company id or institution id (see the next paragraph), choose Florida and a date range, and search.
3. Open a document from a result row.
4. Click **Ask Claude** and type the question. With the search still on screen, Claude knows which filings you mean. Say in the question anything Claude can't know from the filings, for example which product is the private client one and which is middle market.

**Company ids.** S&P's filings API has no company search: every search needs S&P's own company id or institution id. Load a company list (step 2a) and you can find companies by name or NAIC code from the start. Without a list, the app still remembers the name, NAIC code and ids of every company it sees in results, so after one search by id you can find that company by name.

**If something fails,** the message on screen says what S&P answered and gives S&P's reference number. Quote that reference to S&P support.

**What live filings look like so far** (first Live check, 18 Nov 2026: ten rows, one company, Florida). Every assumption the app could test held. The filings had no tracking number and no description, so the app names a filing by S&P's own filing number, marked "S&P no.", on every page, export, email and answer; search by tracking number only for real tracking numbers. Half the filings were over 600 pages, which is why Claude reads long filings in parts. Run a broader search and the Live check again to see whether other states carry tracking numbers and descriptions.

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
| Building a filings profile | 1 for each 10 companies for each year of dates, plus up to 3 for signing in and the lists, more if a year has over 500 filings. At most 60; refused before it starts if its search would need more than 50. 0 if the same search was run before. Claude's text counts as one question. |
| A comparison (Compare tab) | 1 for each 10 companies for each year of dates, across all the carriers together; at most 150. 0 when reopened. |
| Summarising a filing | 1 for the document (2 with a fresh sign-in). 0 for a summary already saved, for searching summaries, and for summaries made after an answer that read the filing. |
| A market index sweep | About 300 for one state for one year with 2,700 companies; about 900 for three years. Searching the index: 0. |
| Building a profile | At most 6 for its filings page (sign-in, the reference lists if they aren't saved, and up to 3 pages of results). 0 when the same profile was built earlier that day. The statutory figures use no S&P request. |
| Asking Claude | Whatever Claude looks up: the searches above plus 1 for each document it reads, and 2 the first time for the lists of insurance types and filing types if they aren't saved yet. One question is capped at 150 S&P requests, 24 lookups, 8 documents or parts of documents, 150 pages a read and 200 document pages in all. A filing longer than 150 pages is read in parts, starting with its front pages; each part costs 1 S&P request, and the answer says which pages of how many were read. |

The app waits its turn so calls are at least a second apart, and stops with a plain message, before calling S&P, when the hour's or day's limit is used up. A search that would need more than 60 S&P requests (40 inside a Claude answer) is refused before any is spent, with the reason. A search with very many pages of results, or one where S&P answers slowly, stops early and says the results are incomplete; an incomplete result is never saved. Each login can have one Claude answer running at a time.

**Claude tokens** (billed to the Anthropic account whose key you set; Claude Opus 5.5 is $4 per million input tokens and $20 per million output tokens). These are estimates; the cost line under each answer shows the real figure:

- A question answered from search results alone: a few cents.
- A question that reads documents: Anthropic counts 1,500 to 3,000 text tokens a page plus an image of each page, about 3,100 to 4,600 tokens in all. A 150-page read is about 465,000 to 690,000 tokens, or $2.30 to $3.50 the first time Claude reads it; each later step of the same answer reads it from Anthropic's cache for about $0.10 to $0.15. The most one question can read, 200 pages, is about $3.10 to $4.60 the first time. A whole 600-page filing would not fit in what Claude can read at once, so long filings are read in parts. If the tab is closed for more than 5 minutes mid-answer, the cache lapses and the documents are paid for once more.
- Claude's text for a profile: one short request with no documents, a few cents. It counts as one question.
- Under each answer the page shows what it cost in US dollars, worked out from Anthropic's list prices for the model that served each request, with the tokens read and written and the S&P requests used. A model not in the price list shows "cost n/d". The line under the question box shows the questions asked today and what they cost. These are estimates; the Anthropic console is the record of what was charged. To update a price, edit `PRICES` in `supabase/functions/_shared/chat.ts`.

**Snowflake credits.** S&P's guide says an X-Small warehouse uses 1 credit an hour while it runs. Snowflake bills a minimum of one minute each time the warehouse wakes, so a statutory query (up to 8 short statements) costs about 0.02 credit, and Discover about the same. A repeated query opens from the saved result and costs nothing, whether it comes from the Statutory view or from Claude. In a reader account the provider (S&P) pays for credits; ask S&P whether use is capped or recharged.

**Supabase and GitHub Pages:** free at this size.

## Supabase limits that matter

From Supabase's documentation in November 2026.

| Limit | Free | Pro ($25 a month) | Why it matters here |
| --- | --- | --- | --- |
| How long one function call may run, background work included | 150 seconds | 400 seconds | A Claude answer runs in slices. Each reply from Claude must fit inside one call; a lookup asked for when the time is nearly up is put off to the next call. |
| CPU time per call | 2 seconds | 2 seconds | Fine: the functions mostly wait on S&P and Claude. Cutting a page range out of a long PDF takes 0.1 to 0.3 seconds; one call spends at most 1 second cutting and puts further reads off to its next call. |
| Memory | 256 MB | 256 MB | A filing document of up to 60 MB passes through. Cutting 150 pages out of a made-up 57 MB, 900-page filing peaked at about 177 MB. A search holds at most 2,000 filings in one function call (about 2.4 MB, peaking near 110 MB of memory on made-up rows); a wider search comes in parts that the page puts together. |
| Time to first response | 150 seconds | 150 seconds | A search is capped at 60 S&P requests to stay inside this. |
| Function calls a month | 500,000 | 2 million | Far above this app's use. |
| Database size | 500 MB | 8 GB | Each saved part of a search is at most 2,000 filings, about 2.4 MB (500 filings is about 0.4 MB). A wide search is saved in parts and opens again without asking S&P. |
| Pausing | After a week with no activity | Never | Step 8 keeps a free project awake. |
| Active projects | 2 | No fixed limit | This app needs a project of its own. |
| Log history | 1 day | 7 days | Useful when chasing an S&P error after the fact. |

**How wide searches work.** No function call holds more than 2,000 filings. A search that returns more comes back in parts: the page asks for each part in turn, shows "3 of about 8 parts, 6,400 filings so far" with a Stop button, and puts the parts together into one result, so the totals, counts, notes, sorting and exports cover the whole search. Stop keeps what has arrived and marks it incomplete, with Carry on to fetch the rest. A part that fails is asked for once more before the page says which part is missing. The limit of 60 S&P requests is for the whole search, and a search that is too wide is still refused before any request is spent. Searches run by Claude, the profiles and the watchlist stop at 2,000 filings and say the result is incomplete; the market index reads a large batch 2,000 at a time and loses nothing. If Supabase ever stops a function for using too much memory or processing time, the page says "This search was too big for the site to run in one go. Narrow the dates, states or companies, or try again."

**How long answers work.** A function call cannot run longer than the first row, and a background task does not extend it. So an answer saves its place after every step and pauses before the limit; the page then asks the function to carry on, and it picks up where it stopped. A reload or a closed tab does not lose an answer. Open the app again and a running answer carries on where it stopped, and one that finished while the page was closed shows as "Answer ready" on the Ask Claude button. An answer only moves forward while the app is open in a tab, so keep the tab open to get it sooner. The panel also lists your own questions from the last 30 days under "Past answers": open one to see the full answer with its sources and table, or ask a follow-up from it. If a function call dies mid-step, the page notices within a minute and the next call starts again from the last saved place.

**When Pro is worth it:**

- Answers stop with "One step of this answer takes longer than Supabase lets a function run". That happens when a single reply from Claude takes more than about two minutes, most likely on questions that read several long filings. On Pro, set `CHAT_SLICE_SECONDS=360`.
- Answers often pause and carry on. Each pause costs up to a minute of waiting. Longer slices on Pro mean fewer pauses.
- You want a third project, or don't want to rely on the keep-awake workflow.
- You need more than a day of logs to diagnose a problem.

## What is still unconfirmed

Nothing in this list is guessed in the code: each item is either handled both ways, or kept behind one function marked `UNCONFIRMED`.

| What | Where it sits | Who confirms it |
| --- | --- | --- |
| **S&P API credentials.** The API does not accept a Capital IQ Pro website login. Sign-in, the filings search and document downloads have run against the live API with a trial account. Tests still use made-up fixtures only. The Live check (step 5) shows which of the assumptions below hold against real answers. | Step 5 | S&P |
| **How long S&P's refresh token stays usable.** The sign-in address, its form-encoded `username` and `password`, the token's `expires_in_seconds` and the refresh call (`POST .../api/v1/tokenRefresh`, form field `refreshToken`) are confirmed by S&P's public Authenticate specification. The app gets a new token a minute before the old one expires. The refresh token lasts up to 7 days and expires after 24 hours without activity; whether ordinary API calls count as activity is not stated, so the app counts only refresh use, the cautious reading. | `signIn` and `refresh` in `_shared/spgmi.ts` | First live call |
| **How long S&P locks an account, and whether the refresh can answer 423.** 423 "Account Locked" at sign-in is confirmed. The app stops signing in for 30 minutes after a 423 from any call. The 30 minutes, and the 5-minute wait after a refused password, are this app's choices, not S&P's. | `_shared/spgmi.ts` | S&P |
| **Whether sign-in errors carry an S&P reference.** The Authenticate specification's error body is `{error, message}` with no request id, so a failed sign-in may show no reference number. | `_shared/connection.ts` | First live call |
| **Florida coverage.** Seen 18 Nov 2026: Florida and all 50 states and DC are in S&P's list, and Florida filings come back, without tracking numbers or descriptions. How complete Florida's coverage is remains a question for S&P. | The state list in step 1 of the first live search | Live check (step 5) |
| **The columns of S&P's reference lists.** The specification does not give them. The app takes the first column ending in "Id" as the id and the next as the name, and keeps the raw rows. Seen 18 Nov 2026 (one fetch of each list): the first column ending in Id is the id and the next the name. | `referenceOptions` in `_shared/filings.ts` | Live check (step 5) |
| **Paging fields in search results** (`totalPages` and so on). They are in S&P's user guide but not the public specification. The app works with or without them. Seen 18 Nov 2026 on one live search: `totalPages` comes back; the app still copes without it. | `searchFilings` in `_shared/filings.ts` | Live check (step 5) |
| **How to find a company's S&P company id or institution id**, and which identifiers these are in Capital IQ Pro. The filings API has no company search and cannot search by NAIC code, so names are looked up in a list you load (step 2a) and in companies seen in earlier results. | `resolveEntity` in `_shared/filings.ts` | S&P |
| **What a filing summary gets right.** Code checks its shape, that every page number is inside the pages read, and that form numbers and rate figures appear in the words quoted for them. It cannot check that the quoted words are on that page or that a program's segment ("private client", "middle market") is judged correctly. | `checkDigest` in `_shared/digest.ts` | Open the filing at the page given |
| **Which filings are form filings, and how form editions read.** A filing type counts as a form filing when its name contains "form"; editions are read as month and year. | `fcFilingTypes` and `fcEdition` in `web/index.html` | The first live comparison of programs and forms |
| **Which carrier a filing belongs to in a comparison.** Each company on a filing is taken to carry the S&P id it was searched by. A filing matching none of the chosen ids is left out and counted. | `cmpOwners` in `web/index.html` | The first live comparison |
| **How many filings a state has, and how many extra pages a sweep needs.** The market index's cost and storage figures assume about 10% extra pages and 5 to 12 MB a state a year. | `_shared/marketindex.ts` | The first sweep |
| **A set's group, expanded from the company list.** A group in a carrier set is matched to the list by name each time it is used. | `setGroupMembers` in `_shared/filings.ts` | Reload of the company list |
| **Which carriers Claude checks for a question about a market.** S&P's filings search has no "every company in a state" option, so for a market or segment question Claude chooses likely carriers itself, looks them up in the company list (several names and whole groups in one step) and says in its answer that the choice is its own and may miss carriers. | `resolveMany` in `_shared/filings.ts`; the system prompt in `_shared/chat.ts` | Read the answer: it names the carriers checked and those not in the list |
| **How filings are sorted in a snapshot.** A filing counts as a rate, rule or form filing when S&P's filing type contains that word, only a status containing "approved" is drawn as approved, and the publish date is taken as close to, not the same as, the regulator's decision. | `snapKinds`, `snapApproved` and `snapDays` in `web/index.html` | Live check, then a look at a real snapshot |
| **Tokens per page of a real filing.** The page limits, the guard on how much Claude is sent at once and the costs above rest on 3,100 to 4,600 tokens a page, and on the front pages of a filing holding its summary, rate information and form schedule. | `LIMITS` and `read` in `_shared/chat.ts` | The cost line under the first live answers that read long filings |
| **The wording that marks a watchlist filing** as a new program, new form, new to a state or a withdrawal, and that S&P's rate impact is in percentage points. The rules were written before any real filing had been seen. | `flagFiling` and `rateChange` in `_shared/watch.ts` | The first live watchlist results |
| **The column headings of a Capital IQ Pro export.** The import matches likely headings and shows what it matched before loading; any column can be named outright. | `matchColumns` in `scripts/companies-lib.mjs` | Your first export |
| **Date and rate-impact formats** in results. The app shows what S&P sends and "n/d" when it is missing. Seen 18 Nov 2026: dates like 2026-01-31. | The Filings view | Live check (step 5) |
| **How S&P counts requests**: whether sign-ins count, and when its day starts. The app counts every call and uses UTC days, so it can only over-count. S&P's public API specification also limits document downloads to 500 an hour on a trial account (1,000 in production); the app does not count those separately. | `makeGate` in `_shared/spgmi.ts` | S&P |
| **Ids are whole numbers and filters are lists.** S&P's specification gives no types; the app follows its examples (company, institution, status, type and filing type ids as numbers; states as two-letter codes). If a live reference list shows text ids, searches by that filter will be refused until this is changed. Seen 18 Nov 2026: reference ids are whole numbers and states two-letter codes. In result rows the filing type id came as digits in text; the app treats "1" and 1 as the same id. | `parseSearch` in `_shared/filings.ts` | Live check (step 5) |
| **Pages of results are numbered from 1**, as in S&P's example. Seen 18 Nov 2026 on one live search. | `searchFilings` in `_shared/filings.ts` | Live check (step 5) |
| **One filing version has one document, state and set of dates.** When several rows share a `filingVersionId`, the app keeps the first row and lists every company on it. | `dedupe` in `_shared/filings.ts` | Live check (step 5) |
| **What `pages` means.** Taken as the document's page count. The app also counts the pages in the file and uses the larger number for Claude's limits. | `read` in `_shared/chat.ts` | First live answer |
| **What a `filingVersionId` looks like.** S&P's example is a 36-character id; the app passes on any id of 8 to 64 letters, digits, dots, underscores and dashes. Seen 18 Nov 2026 (10 rows): both ids fit the shapes the app accepts. | `parseDocRef` in `_shared/filings.ts` | Live check (step 5) |
| **How S&P answers a wrong username or password.** 401 "User unauthorized" is confirmed by the Authenticate specification. A 400 at sign-in is not in the specification; the app reads it as a refused sign-in too. | `signIn` in `_shared/spgmi.ts` | First live call |
| **The unit of `overallRateImpact`.** Shown as a percentage when S&P's display value is missing. Seen 18 Nov 2026 (6 of 10 rows, -11 to -0.8): percentage points; S&P's display value was empty on every row. | The Filings view (`web/index.html`) | Live check (step 5) |
| **How an account name with an underscore is written in the Snowflake sign-in token.** Snowflake's documentation does not say; the app keeps the underscore. | `jwtAccount` in `_shared/snowflake.ts` | First Snowflake call |
| **Whether S&P limits API access to fixed IP addresses.** Supabase functions do not have fixed addresses. | n/a | S&P |
| **The Snowflake reader account**: the account identifier, the service user with key-pair sign-in, and the warehouse name. | Step 7 | S&P |
| **Every SNL Insurance Regulatory view and column name.** | The mapping (step 7); `buildSql` in `_shared/statutory.ts` | Discover, then Corp Dev |
| **The extra statutory figures a profile uses** (net premiums earned, net income, reserves, reserve development, RBC ratio, ceded premiums by reinsurer and the rest in step 10). They are the app's own names; whether S&P's views hold each one, and in which column, is not known until Discover. | The mapping (step 7) | Discover, then Corp Dev |
| **The storage rules for the template.** The migration uses the statements Supabase documents for storage policies, but has not been run against a real project. | `0004_profile_template.sql` | First upload of the template |
| **How the profile comes out on the real template.** It is tested on a made-up stand-in with the same layout names. | `web/deck.js` | The sample profile, opened in PowerPoint |
| **Who pays for Snowflake credits** and whether use is capped. | n/a | S&P |
| **Cloudflare sign-on: what the first live sign-in did not cover.** The first sign-in through Cloudflare worked on 18 Nov 2026, which confirms that Access passes its sign-in to a Worker serving static files, that `snl-signin` accepts a call carrying only the publishable key, and the two Supabase calls that make a session. Tests otherwise use stand-ins. Still to confirm: a colleague signing in with a one-time code; that Access's logout address signs the browser out on a `workers.dev` address; that removing a person cuts them off within the hour. | `worker/index.js`, `_shared/access.ts` | The first colleague's sign-in, a sign-out, and the first removal |
| **The richer filings profile on real filings.** Whether Claude finds the indicated change, loss cost multiplier and assumptions in real rate filings and quotes them so the check keeps them; how often filings state premium and policyholders; whether the market comparison's exact match on type of insurance works on real index data; how the maps look in PowerPoint itself (checked in LibreOffice and python-pptx only). | `_shared/digest.ts`, `_shared/profile.ts`, `web/deck.js` | First real filings profile with summaries |
| **Templates of your own.** Tested against a stand-in for Supabase Storage. The page tells whether 0008 has been run by whether a login can see the bucket's settings; if some other rule already allows that, the page would offer uploads that storage then refuses. | `0008_own_templates.sql` | First upload of a template of your own |
| **Wide searches in parts, live.** The 2,000-filing bound and its memory figures come from made-up rows; real rows may be wider. Unconfirmed: Supabase's status and wording when it stops a function (taken from its documentation), and whether the browser can read a request id from that answer. Two people running the same wide search at the same moment share one place-keeper, and one of them is asked to search again. | `_shared/filings.ts` | The first live search of more than 2,000 filings |
| **Narrowing by filing type and status, live.** Which filings count as rate, rule and form rests on S&P's filing type names (`snapKinds`, `fpKinds`), still a guess, and the "left out by the narrowing" wording builds on it. Unconfirmed: that a filing's status id matches S&P's status list the way its filing type id was seen to; how many filing type and status names a real index holds; that `0010_market_more_filters.sql` behaves on the live project as it did on a local Postgres. | `web/index.html`, `_shared/profile.ts`, `0010_market_more_filters.sql` | The first Snapshot narrowed to rate filings, and the first Market search by status |
| **Narrowing by type of insurance, live.** That S&P's `typeOfInsuranceId` filter returns only those types, and that the type names on returned filings match S&P's reference list (narrowing what is on screen matches on the name). That `0009_market_filters.sql` is fast enough on a full index; it was measured on a few rows only. | `web/index.html`, `0009_market_filters.sql` | The first narrowed Snapshot and Market search |
| **Filing summaries against Anthropic's live API.** A summary is asked for in a fixed shape, and Anthropic refuses a shape with more than 16 fields that may be empty, 24 optional fields or 20 strict tools. On 18 Nov 2026 the summary shape had 39 such fields and every summary failed; it now has 8, and `tests/functions/claudelimits_test.ts` counts every shape the app sends against those limits. Unconfirmed until the next live summary: that Anthropic accepts the smaller shape together with the uploaded file and the fallback setting. If it refuses, the page now shows Anthropic's own reason. | `_shared/digest.ts` | The next summary made on the live site |
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

Every suite one after another takes about 20 minutes, most of it the browser suites. To run part of them, name them or ask for one part:

```bash
npm test -- filings chat
```

```bash
npm test -- --shard=2/4
```

On GitHub the suites run as four parts on separate machines at the same time, and a pull request shows one check, `test`, which is green only when every part passed. `tests/shards.mjs` shares the suites out so that every suite is in exactly one part and the parts take about as long as each other, using how long each suite took when last timed (`tests/durations.json`). A new suite needs nothing: it is given a time from its size until it is timed. To time the suites again after adding several, run `npm test -- --timings` and commit the file. To change the number of parts, change the list of parts in `.github/workflows/tests.yml`.

## Notes

- **Saved results.** A search, a reference list or a statutory query is saved the first time and reopened from Supabase after that, with the date it was fetched. Refresh asks S&P again.
- **Recent searches.** The Filings view lists the searches anyone on the team has run, newest first. Clicking one fills the form and opens its saved result, so it costs no S&P request; Refresh asks S&P again.
- **Empty results.** When S&P returns nothing for a state or a company, the app says exactly that. It never says no filings exist.
- **Progress bars.** A search or long step shows a bar. It fills only by what the page is told (parts, searches, summaries or batches done, with "about" while the total is an estimate); a single call shows a moving band and, after a few seconds, the time so far. A stopped search keeps its bar where it got to, marked "Stopped"; a failed one is marked "Didn't finish" and is never shown full. Waits under a second show no bar.
- **Documents.** Usually PDFs. Claude reads a whole document of up to 150 pages, or any range of up to 150 pages of a longer one, and up to 200 pages for one question. Its answer says which pages of how many it read, and page citations use the filing's own page numbers. When S&P gives no page count, or the file's pages are packed so they can't be counted directly, the app opens the file to count them. Password-protected or damaged files that need cutting are refused with a plain message; open them from the Filings view.
- **Follow-up questions** in the same conversation carry the earlier questions and answers, not the documents. Claude re-reads a document if it needs it again (1 S&P request).
- **Bulk download** (the "API Drive" delivery in S&P's API specification) needs separate credentials and is not used.
- **Snapshot figures.** A rate impact is S&P's overall figure for the filing: it isn't weighted by premium, and for a filing that isn't approved it may be what was asked for. A state where S&P returned nothing is drawn with a dashed outline and never shown as zero. A snapshot covers at most as many companies as one search (100).
- **Searching a whole group.** Type a group's name in the company finder and choose "Add all" on the group: one search takes up to 100 companies. S&P counts one request for each 10 companies for each 365 days of dates, and one search may use at most 60 (Claude: 40). A 69-company group costs about 7 requests a year: 12 months, 3 or 5 years run; 10 years is refused, with a message saying how many years or companies would fit.
- **Keeping a search out of Recent searches.** Tick "Keep this search out of Recent searches" on the Filings form. The result is still saved, so the same search costs nothing again, but it isn't listed. Whoever last fetches a search from S&P decides whether it is listed; opening a saved result changes nothing. This hides a search from the list, not from the database: any login can still read saved results there. Searches that Claude runs inside an answer, and the search behind a company profile, are always kept out of the list.
- **One answer at a time.** A login with an answer in progress is asked to wait before asking another. If its tab was closed, open the app again to pick it up, or a new question is accepted ten minutes later.
- **Housekeeping.** Finished answers are removed after 30 days, and leftovers from abandoned answers are cleared whenever someone opens the app.
