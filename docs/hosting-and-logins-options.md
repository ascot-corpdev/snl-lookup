# Hosting and logins: options

Status: exploration written 18 Nov 2026; decision and build the same day (below). Nothing here changes the GitHub Pages site, its workflows or the functions.

## Decision (18 Nov 2026)

Cloudflare Access is the login: a one-time code by email for everyone, the admin included. No Entra app registration (IT hasn't approved one). The admin is named by email in the Worker setting `ADMIN_EMAILS` and gets the `corpdev` role; everyone else the Access policy lets in gets `reader`. The site runs on a Worker on a workers.dev address; GitHub Pages keeps working until the owner switches. Supabase stays for data, functions, storage and cron. Built in `cloudflare/`; set-up in the README, "Sign-in with Cloudflare Access".

One change from option A3 as first sketched: the Worker signs tokens with the project's own key (the legacy JWT secret, or a key imported into Supabase) instead of registering itself as a custom OIDC issuer. Supabase Auth then accepts the token like its own, so `auth.getUser` in the functions works unchanged, and no proxy or public `/.well-known` address is needed. Supabase Auth's source shows it checks a token without a key id against the legacy secret, needs no session id, and only needs `sub` to be an existing login; the Worker creates that login with the admin API.

The ask: "let's explore moving to AWS and Cloudflare logins with worker devs and multiple logins". Read as: where the app could run (Cloudflare Workers, AWS, or both), how people would sign in (Cloudflare Access with the company's Microsoft Entra ID, one-time PINs for outsiders, several identity providers, a login per person), per-branch preview sites on `*.workers.dev`, and what happens to Supabase.

## The short answer

| | Cheapest and quickest | Cleanest long term |
| --- | --- | --- |
| What | Put Cloudflare Access (Entra sign-in) in front of the existing site. Keep Supabase as is. Then swap passwords for "Sign in with Microsoft". | Access is the only login. A small Worker turns the Access identity into a short-lived token Supabase trusts. Supabase stays for data, functions and storage. |
| Effort | 1 to 2 days, then 2 to 3 | 6 to 9 days in all, after a 1-day spike |
| Running cost | $0 a month | $0 to $5 a month (plus Supabase Pro if wanted) |
| Main gap | Supabase is still reachable directly with a password until the second step | New, less-trodden path (Supabase custom OIDC); needs the spike first |

Moving everything to Cloudflare (option B) or to AWS (option C) is possible but costs 15 to 30 days and buys little at a team of a few dozen. Do it only if IT requires it or Supabase's limits start to bite.

## What "multiple logins" means here

1. **A login per person.** Today two shared logins (`corpdev1`, `corpdev2`) are seeded by `scripts/logins.mjs`. With SSO each person signs in as themselves, which also gives a real name on the team library, the settings stamp and the daily question limit.
2. **Several ways in.** Entra SSO for staff, a one-time PIN by email for a named outsider, and perhaps a break-glass login. Cloudflare Access does this on one sign-in page.
3. **Roles.** Today one role per login (`corpdev` or `reader`, `ceo` in the deal desk) in `public.profiles`. Roles can stay there (Corp Dev manages them) or come from Entra groups (IT manages them).
4. **One person, several identities.** For example the same person by Microsoft and by PIN. Supabase links identities with the same email; Access keys on the email too.
5. **Several environments.** Production, a dev copy and a preview per branch, each with its own sign-in rule.

## Today's dependency map

### Supabase Auth

| Where | What it relies on |
| --- | --- |
| `web/index.html` sign-in (`signInWithPassword`, around line 6142) | Username turned into `username@<usernameDomain>` and a password. |
| `web/index.html` session (`getSession`, `onAuthStateChange`, `signOut`) | The supabase-js session in the browser; `callFn` sends its access token to every function. |
| `web/index.html` change password (`auth.updateUser`, around line 5543) | Password logins. |
| `web/index.html` role check on sign-in (around line 6131) | Reads `profiles.role` for the signed-in user; no role means signed out. |
| `scripts/logins.mjs` | `auth.admin.createUser` with a made-up email, then a `profiles` row. Seed, add, reset, remove, list. Needs the secret key. |
| `supabase/functions/_shared/http.ts` `whoIs` | Every function calls `sb.auth.getUser(token)` (a call to Supabase Auth) and then reads `profiles.role` with the caller's token. Functions deploy with `verify_jwt = false`. |
| Foreign keys | `profiles.id` and `snl_jobs.owner` reference `auth.users(id)`. |
| `auth.uid()` in SQL | `app_role()`, the `snl_jobs` read policy, `snl_settings.updated_by` and the `stamp_update` trigger. |

`whoIs` matters most for any change: a token from another issuer (custom OIDC, Cognito) fails `auth.getUser` even if Postgres accepts it. A token signed with the project's own key, for an existing login, passes (see the decision above). Any option that replaces Supabase Auth must change `whoIs` to check the token another way (for example, verify it against the issuer's keys, or ask Postgres `select auth.uid()` with it).

### Row-level security

- `public.app_role()` reads the caller's role from `profiles` by `auth.uid()`.
- Every table: read when `app_role() is not null`. Answers (`snl_jobs`): own rows only.
- `snl_settings`: Corp Dev may insert and update. The browser writes three settings directly: `watchlist`, `carrier_sets` and `statutory_mapping`.
- Storage bucket `snl-template`: any login reads, Corp Dev uploads, replaces and deletes (migration 0004).
- `anon` gets nothing except `keepalive()`.
- The functions write with the service role, which bypasses RLS.

### Postgres features beyond plain tables

- `snl_take_slot`: a PL/pgSQL row lock that holds S&P's one-request-a-second limit across concurrent function calls.
- Migration 0006: PL/pgSQL functions for the market index (`snl_index_put`, `snl_index_query` and others).
- Migration 0005: a generated `tsvector` column searched with Postgres word search.
- Partial unique indexes that allow one running watch check and one open sweep.

### Storage

One private bucket, `snl-template`, holding the PowerPoint template (up to 50 MB). The browser lists, downloads and uploads it with supabase-js.

### Edge Functions

| Function | Notes that matter for a move |
| --- | --- |
| `snl-filings` | Streams filing documents (up to 60 MB) straight through to the browser. |
| `snl-chat` | Claude answers run in slices in the background (`EdgeRuntime.waitUntil`), save their place, and the page asks for the next slice. Default slice 110 s; 360 s on Pro. Cuts PDF page ranges with pdf-lib; a 57 MB filing peaked at about 177 MB of process memory. Uploads parts of up to 32 MB to Anthropic. |
| `snl-statutory` | Snowflake SQL API over HTTPS with a key-pair JWT signed by WebCrypto. No driver. |
| `snl-watch`, `snl-index` | Called by a login, or by Supabase Cron with a shared secret header. |
| `snl-profile`, `snl-digest` | Snowflake, S&P and Anthropic, like the others. |

All are Deno with `npm:` imports pinned to exact versions. Supabase limits (checked 18 Nov 2026, [Supabase Edge Function limits](https://supabase.com/docs/guides/functions/limits)): 256 MB memory, 2 s CPU a request, 150 s wall clock on Free and 400 s on paid plans.

### Secrets (all in Supabase function secrets)

`SPGMI_API_USERNAME`, `SPGMI_API_PASSWORD`, `SPGMI_ACCOUNT`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `CHAT_SLICE_SECONDS`, `CHAT_DAILY_LIMIT`, `ORG_NAME`, `SNOWFLAKE_*` (account, user, warehouse, private key or PAT, role, database, schema), `WATCH_SECRET`, `INDEX_SECRET`, `INDEX_TOPUP_DAYS`, `RESEND_API_KEY`, `WATCH_FROM`, `SITE_URL`, `ALLOWED_ORIGIN`. Supabase injects `SUPABASE_URL`, the service key and the anon key.

### Cron

`supabase/watch_schedule.sql` (daily) and `supabase/index_schedule.sql` (every 10 minutes) use `pg_cron` and `pg_net` to call the functions, with the URL and shared secret in Supabase Vault. They call `*.supabase.co` directly, so nothing in front of the site affects them.

### GitHub and the public-repo model

- `pages.yml` writes `web/config.js` from repository variables (Supabase URL, publishable key, username domain, org name) and publishes `web/` to GitHub Pages. A merge to `main` is a deploy.
- `keepalive.yml` calls `keepalive()` daily so the free project doesn't pause.
- `tests.yml` runs every suite on each pull request.
- The repository is public and holds no secret. The site URL is public too: anyone can load the sign-in page. The publishable key is in the page by design; RLS and the functions' own login checks are the only gate.

## Facts checked for this note

All checked on 18 Nov 2026. Prices are list prices in US dollars.

| Fact | Value | Source |
| --- | --- | --- |
| Cloudflare Zero Trust (Access) free plan | $0, up to 50 users; 24 hours of logs | [Cloudflare Zero Trust plans](https://www.cloudflare.com/plans/sase-zero-trust.md) |
| Zero Trust pay-as-you-go | $7 a user a month, 30 days of logs | same |
| What uses a seat | Any Access sign-in; the seat is held until the user is removed (or an inactivity expiry is set) | [Seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/) |
| Access with Entra ID | Web redirect `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`; client secret; delegated Graph permissions including `Directory.Read.All` and `GroupMember.Read.All` with admin consent; "Support groups"; PKCE; groups by object id unless SCIM (SCIM needs Entra P1 or P2) | [Entra ID in Zero Trust](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/entra-id/) |
| One-time PIN | PIN to any email an Access policy allows; can sit beside Entra on the same app | [One-time PIN](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/) |
| Access token to the app | `Cf-Access-Jwt-Assertion` header, RS256, keys at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`; check `aud` and `iss` | [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) |
| Access on a Worker | One switch protects the Worker's custom domains, `workers.dev` and preview URLs; `ctx.access` gives the identity | [Workers and Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [changelog 3 Oct 2025](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) |
| Worker preview URLs | `<alias>-<worker>.<subdomain>.workers.dev`, alias set by `wrangler versions upload --preview-alias` (Wrangler 4.21+); alias plus name at most 63 characters; previews have no logs | [Preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/) |
| Workers Builds | Builds from GitHub; non-production branches update a Preview with a URL | [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) |
| Pages previews | `<branch>.<project>.pages.dev`; "Enable access policy" protects previews only | [Pages previews](https://developers.cloudflare.com/pages/configuration/preview-deployments/) |
| Workers limits | Memory 128 MB. CPU 10 ms (Free); 30 s default, up to 5 min (Paid). Wall time unlimited while the client is connected. `waitUntil()` at most 30 s after the response. Request body 100 MB on a Free or Pro zone. No response size limit. Subrequests 50 (Free) or 10,000 (Paid). 5 cron triggers (Free), 250 (Paid). | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers pricing | Free: 100,000 requests a day. Paid: $5 a month minimum, 10M requests and 30M CPU ms included | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| D1, KV, R2 | D1: 5 GB included on Paid. KV: 1 GB included. R2: 10 GB free, no egress fee | same |
| Workflows | Unlimited wall time per step; CPU 30 s default, up to 5 min per step (Paid) | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits) |
| Supabase third-party auth | Clerk, Firebase, Auth0, Cognito, WorkOS, or any custom OIDC issuer. Tokens must be asymmetric with a `kid`. $0.00325 per third-party MAU above the plan's quota (50,000 Free, 100,000 Pro) | [Third-party auth](https://supabase.com/docs/guides/auth/third-party/overview), [pricing](https://supabase.com/pricing) |
| Supabase custom OIDC | HTTPS issuer with `/.well-known/openid-configuration`; token needs `role: authenticated`, else it runs as `anon`; `auth.uid()` works only if `sub` is a UUID; set up in the dashboard or Management API, not the CLI | [Custom OIDC provider](https://supabase.com/docs/guides/auth/third-party/custom-oidc) |
| Supabase "Sign in with Microsoft" | Azure provider can be locked to one tenant (`https://login.microsoftonline.com/<tenant-id>`); needs the `email` scope; `xms_edov` claim recommended | [Sign in with Azure](https://supabase.com/docs/guides/auth/social-sign-in/auth-azure) |
| Supabase SAML SSO | Pro: 50 SSO MAU included, then $0.015 each; not on Free | [SSO MAU](https://supabase.com/docs/guides/platform/manage-your-usage/monthly-active-users-sso) |
| Supabase plans | Free $0 (pauses after a week idle, 500 MB). Pro from $25 a month (8 GB, no pausing) | [Supabase pricing](https://supabase.com/pricing) |
| Cognito | Lite and Essentials: 10,000 direct MAU free. Federated SAML or OIDC: 50 MAU free per account, then $0.015. Free tier does not expire | [Cognito pricing](https://aws.amazon.com/cognito/pricing/) |
| Lambda | 128 MB to 10,240 MB memory; 15 min timeout; 6 MB request and response, 200 MB streamed response; environment variables 4 KB in all | [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |
| API Gateway REST | Response streaming and integration timeouts up to 15 min (announced 19 Nov 2025) | [AWS announcement](https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis) |

Not checked here: Amplify Hosting, RDS and Aurora prices. Figures for those below are labelled estimates.

## Option A: Cloudflare in front, Supabase kept

The site moves from GitHub Pages to a Worker serving `web/` as static assets. Access protects the Worker. Supabase keeps the data, the functions, storage and cron. Three ways to tie the Access identity to Supabase, from least to most change:

| | A1. Double gate | A2. Microsoft sign-in in Supabase | A3. Worker as identity broker |
| --- | --- | --- | --- |
| How | Access (Entra, PIN) guards the site. Supabase password logins unchanged. | Access guards the site. Supabase Auth uses its Azure provider, locked to the company's tenant. Passwords switched off. | Access is the only login. A Worker checks the Access token, looks up the person's profile, mints a 5-minute RS256 token and forwards the call to Supabase. Supabase trusts the Worker as a custom OIDC issuer. |
| User sees | Microsoft sign-in, then the app's own sign-in | Microsoft sign-in twice, usually silent the second time | Microsoft sign-in once |
| Supabase reachable without Access | Yes, with a password | Yes, but only by a company Entra account with a profile | Yes at `*.supabase.co`, but with no way to get a token except through Access |
| Outsiders by PIN | Need a Supabase password login too | Need a password login or an Entra guest account | Work as is |
| Code change | None in the app. New `wrangler.toml` and deploy workflow. | Sign-in button and redirect in `web/index.html`; `logins.mjs` pre-creates users by real email. | Page drops its sign-in form and session; `whoIs` checks the minted token instead of `auth.getUser`; a profile lookup the Worker can use. No RLS change if the token's `sub` is the existing `auth.users` id. |
| Effort | 1 to 2 days | +2 to 3 days | +4 to 6 days, after a 1-day spike |

**Logins and roles.** Access policy: allow members of an Entra group (by object id, or by name with SCIM), plus named PIN emails. App roles stay in `profiles`. They could later be read from Entra groups (Access passes groups when "Support groups" is on), but keeping them in the app keeps Corp Dev in control and avoids a Graph dependency.

**Previews.** Production on a custom domain or `snl-lookup.<subdomain>.workers.dev`; a second Worker (`snl-lookup-dev`) for previews, uploaded with `--preview-alias <branch>` from a GitHub Action on each pull request. Access covers the previews with the same switch. Previews should point at a dev Supabase project, not production (S&P quota and data are shared otherwise). Note: Supabase Free allows two active projects per organisation, and this app and the deal desk may already use both. A dev project may mean Pro ($25 a month) or a second organisation.

Preview origins change per branch, and `allowOrigin` in `_shared/http.ts` only matches exact origins. Either the Worker proxies Supabase under the site's own origin (`/sb/*`, as in the prototype), which removes CORS entirely, or `allowOrigin` learns a `*.workers.dev` suffix rule. The proxy is cleaner.

**Secrets.** Unchanged in Supabase. The Worker holds only the Access team domain and audience tag (not secret) and, for A3, its signing key (`wrangler secret put`). For A3 the email-to-profile map can live in Workers KV, written by `logins.mjs`, so the Worker never holds a Supabase secret key.

**Claude, S&P and Snowflake.** No change: the functions stay on Supabase. The proxy streams responses, so 60 MB documents and Claude answers pass through untouched (Workers have no response size limit; a request body may be up to 100 MB, above the 50 MB template upload).

**Cost.** $0: Access free up to 50 users, static assets and a light proxy fit the Workers free plan. Workers Paid ($5) only if the proxy's CPU or the 100,000 requests a day are ever tight.

**Risks.**
- A1 alone leaves Supabase reachable with a password. It hides the site, nothing more.
- A3 rests on Supabase accepting Worker-minted tokens through custom OIDC; documented, but this app hasn't tried it. Supabase must reach the Worker's `/.well-known/*` without Access (a bypass rule for that path, or a separate issuer Worker).
- GitHub Pages must be switched off or the old URL stays up (it shows only the sign-in page, but still).
- Access free plan logs last 24 hours; audit wants may push to pay-as-you-go.
- Seats are held until removed; other use at the company of the same Zero Trust account shares the 50 seats.

**Sign-off.** Entra app registration for Access (admin consent for the Graph permissions above), and for A2 a second registration or redirect URI for Supabase. Cloudflare as a vendor (security review, DPA). A DNS record under a company domain, if not `workers.dev`.

## Option B: Cloudflare-native, Supabase removed

Workers for the functions, D1 (SQLite) for the tables, R2 for the template, KV for small caches, Secrets for credentials, Cron Triggers for the watchlist and index, Access for logins.

- **Logins.** Access only; the Worker reads `ctx.access` or verifies the token. Roles in a D1 table or from Entra groups. PIN for outsiders works.
- **Previews.** Best of all options: every branch gets a preview URL, D1 and KV can be bound per environment.
- **Secrets.** `wrangler secret put` per Worker; 128 variables a Worker on Paid.
- **What breaks.**
  - No RLS in D1. Every check moves into Worker code, and the page's direct database reads and writes (about 20 supabase-js calls) become API endpoints.
  - `snl_take_slot`, the market index functions and word search need rewriting (a Durable Object suits the throttle; SQLite FTS5 for search).
  - Memory is 128 MB a Worker. Cutting pages from a 57 MB filing measured 177 MB here, so long filings would need a lower size cap or a container.
  - `waitUntil()` stops 30 s after the response, so background Claude slices must move to Workflows or a Durable Object. Long answers can stream while the browser stays connected, since wall time is unlimited then and the CPU (mostly waiting on Anthropic) stays well inside 30 s.
- **Effort.** 20 to 30 days, plus a full re-test.
- **Cost.** $5 a month (Workers Paid, needed for CPU time); D1, KV, R2 within included amounts at this size.
- **Risks.** Largest rewrite; loses the security model the code and tests are built around; PDF memory.
- **Sign-off.** As A, plus Cloudflare holding S&P data at rest (check the S&P licence and data residency; D1 location hints exist but the default is not a fixed region).

## Option C: AWS

S3 and CloudFront (or Amplify Hosting) for the site, Cognito federated with Entra (SAML or OIDC) for logins, Lambda behind API Gateway or function URLs for the functions, and either Supabase kept or RDS/Aurora Postgres.

- **Logins.** Cognito managed login; Entra as the federated provider; Cognito groups for roles. Outsiders as Cognito native users with email codes. Supabase lists Cognito as a supported third-party issuer, so C can keep Supabase for data with the same `role: authenticated` claim and `whoIs` change as A3.
- **Previews.** Amplify Hosting offers branch and pull-request previews (not re-checked here); with S3 and CloudFront it's build-your-own.
- **Secrets.** Secrets Manager or SSM Parameter Store. Lambda's 4 KB limit on all environment variables in total is too small for the Snowflake private key plus the rest.
- **Claude, S&P and Snowflake.** Best fit for the heavy work: up to 10 GB memory and 15 minutes per call, so PDF cutting and a whole Claude answer fit one invocation, and streamed responses up to 200 MB. The Deno code needs porting to Node (entry points, `npm:` imports, `EdgeRuntime.waitUntil`).
- **Effort.** 10 to 15 days keeping Supabase for data; 20 to 25 days with RDS (RLS still works in plain Postgres, but PostgREST is gone, so the page's direct reads need an API).
- **Cost.** Cognito about $0 (under 50 federated MAU free). Lambda, API Gateway, S3 and CloudFront: a few dollars a month at most at this volume (estimate). RDS or Aurora: roughly $15 to $60 a month for the smallest always-on Postgres (estimate, not checked; price it in the AWS calculator).
- **Risks.** Most moving parts to own (IAM, VPC if RDS, CloudFront, Cognito). Cognito's sign-in pages and token handling are heavier for a one-page site.
- **Sign-off.** A company AWS account inside IT's organisation and guardrails, region choice, the Entra enterprise app for Cognito.

## Option D: hybrid

Cloudflare for the edge and logins (Access, static site, previews), AWS Lambda for the heavy calls (`snl-chat`, `snl-digest`, PDF cutting), data in Supabase or RDS.

- The Worker checks Access and calls a Lambda function URL signed with a shared secret or IAM.
- Fixes the two real Supabase limits (2 s CPU, 150 to 400 s wall clock) without giving up RLS.
- Snowflake: S&P's reader account sits in a cloud and region S&P chose (not known yet). If it is AWS, putting Lambda in the same region shortens each statutory query; at this volume the difference is small. The Snowflake SQL API is plain HTTPS with a WebCrypto-signed JWT, so it runs anywhere.
- **Effort.** A, plus 5 to 8 days for the Lambda port of the chat path.
- **Cost.** A, plus a few dollars a month.
- **Sign-off.** Both vendors.

## Side by side

| | A (A3) | B | C | D |
| --- | --- | --- | --- | --- |
| Single sign-on with Entra | Yes | Yes | Yes | Yes |
| PIN for outsiders | Yes | Yes | Email codes | Yes |
| Previews per branch | workers.dev | workers.dev | Amplify | workers.dev |
| RLS kept | Yes | No | Yes with Supabase | Yes |
| Long Claude answers, big PDFs | As today | Harder | Easier | Easier |
| Effort (days) | 7 to 11 | 20 to 30 | 10 to 25 | 12 to 19 |
| Running cost a month | $0 to $5 | $5 | $5 to $65 | $5 to $10 |
| Vendors to clear | Cloudflare | Cloudflare | AWS | Both |

## Recommendation

1. **Step 1, now (1 to 2 days, $0).** Serve `web/` from a Worker with Access in front: Entra group for staff, named PIN emails for anyone else. Keep Supabase and its logins. Switch off the GitHub Pages deploy. This hides the site from the internet with almost no code change.
2. **Step 2, next (2 to 3 days, $0).** Personal logins: either A2 ("Sign in with Microsoft" in Supabase, passwords off, shared logins retired), or, if PIN outsiders matter, go straight to A3 after a one-day spike with the prototype. Add the `/sb/*` proxy so the site talks to Supabase from its own origin.
3. **Step 3, then (2 to 3 days, $0 to $25 a month).** Pull-request previews on `workers.dev`, behind Access, against a dev Supabase project.
4. **Step 4, only if justified.** If answers keep hitting Supabase's time or memory limits, try Supabase Pro first ($25). If that is not enough, or IT requires AWS, move the chat path to Lambda (D). Don't take B for this app: it trades away RLS and fights the 128 MB and 30 s limits.

Cheapest and quickest: step 1. Cleanest long term without a big rewrite: A3 (one login, Entra groups, PIN outsiders, no passwords, Supabase for data). Cleanest if IT wants everything on AWS: C with Supabase kept for data.

## The deal desk

The same steps apply, with these differences:

- **More sensitive data.** It holds deal, banker and pipeline information. Hiding the site behind Access is worth more there than here.
- **More direct writes.** The page writes deals, bankers and notes straight to Postgres under RLS, and history triggers stamp `auth.uid()`. A3 must keep the token's `sub` equal to the existing `auth.users` id so those triggers and the CEO-question policy keep working.
- **Already uses Entra.** It has (or plans) an Entra SPA registration for Ask Copilot and the Teams card, with a redirect URI on `github.io/.../auth.html`. Moving host means adding the new redirect URI. That registration is separate from login and needs its own admin consent; it is a useful precedent when asking IT.
- **Roles** are `ceo` and `corpdev`. The CEO is a natural "SSO only, no password" user.
- **Streaming chat** (`comps-chat`) passes through the proxy unchanged.
- **Cron** (weekly digest) and the keepalive work as here.
- One Cloudflare account and one Zero Trust organisation can serve both apps; each user takes one seat across both.

## What was built

`cloudflare/` replaces the earlier prototype.

- `bridge.js` checks Access's sign-in (the token against the team's keys, with audience, issuer and expiry, or the Workers runtime's `ctx.access`), maps `ADMIN_EMAILS` to `corpdev` and everyone else to `reader`, finds or creates the Supabase login and its profile with the secret key, and mints a 15-minute token (HS256 with the legacy secret, or ES256 or RS256 with an imported key).
- `worker.js` is the entry point; `wrangler.toml` serves `web/` as static assets, with the Worker running first only for `/config.js` and `/access/session`. No setting is in the file.
- `web/index.html` signs in through the Worker when `config.js` sets `accessLogin`, renews the token, and signs out through Access. Without `accessLogin` the password form is unchanged.

Checked: unit tests for the Worker and the page; the Worker run in Cloudflare's runtime (`wrangler dev`) against a fake Access key server and a fake Supabase; the migrations' row-level security run in Postgres 16 with the minted token's claims. Not yet checked: a hosted Supabase project accepting the token, and how Access hands the sign-in to a workers.dev Worker (both handled; see the README's "What is still unconfirmed").

## Open questions

1. **Entra.** Will the company's IT register an Entra app for Cloudflare Access, with admin consent for `Directory.Read.All` and `GroupMember.Read.All` (or narrower, if they prefer and we test it)? Is there an Entra group for Corp Dev, or should one be made?
2. **Cloudflare at the company.** Does the company already have a Cloudflare account or Zero Trust organisation? If so, whose seats does it use, and will IT own the Access policies?
3. **AWS.** Is AWS required by IT, preferred, or only an option? Is there a company AWS organisation this would sit in?
4. **Domain.** Is `*.workers.dev` acceptable, or should it live under a company domain (needs a DNS record or a zone on Cloudflare)?
5. **Outsiders.** Who would sign in by PIN? Does the S&P licence allow people outside the company to see S&P data through this app?
6. **Data residency.** Must data stay in the US? Which region is the Supabase project in? Is Cloudflare's global edge acceptable for traffic passing through?
7. **Roles.** Should roles come from Entra groups (IT manages) or stay in the app (Corp Dev manages)?
8. **Supabase plan.** Is a second (dev) Supabase project acceptable, and on which plan?
9. **Snowflake.** Which cloud and region is S&P's reader account in?
