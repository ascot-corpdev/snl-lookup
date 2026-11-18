// Cloudflare sign-on (supabase/functions/_shared/access.ts and snl-signin): the Access token is checked here, by
// the function itself, against a made-up team's keys; a good sign-in finds or creates the user, keeps the profile
// and role, and returns a short session without its refresh token. Every name, address and key is made up.
(globalThis as any).__SNL_TEST__ = true;
const fn = await import(new URL("../../supabase/functions/snl-signin/index.ts", import.meta.url).href);
import { accessSettings, adminEmails, checkAccessToken, cleanEmail, displayNameFrom, KeyStore, MSG, roleFor, signIn, supabaseSigninStore, teamHost, upkeepProfile, usernameBase } from "../../supabase/functions/_shared/access.ts";
import { accessTeam, checks, env, fakeClock, J, memorySignin } from "./helpers/fakes.ts";

const { ok, done } = checks();
const silently = async <T>(work: () => Promise<T>): Promise<T> => { const keep = console.error; const said: string[] = []; console.error = (...a: unknown[]) => { said.push(a.map(String).join(" ")); }; try { return await work(); } finally { console.error = keep; (silently as any).said = said; } };

const kit = await accessTeam();
const clock = fakeClock();
const NOW = clock.now, SEC = Math.floor(NOW / 1000);
const SETTINGS = { team: kit.team, auds: [kit.aud] };
const ENV = { CF_ACCESS_TEAM_DOMAIN: kit.team, CF_ACCESS_AUD: kit.aud, SNL_ADMIN_EMAILS: "Owner@Calloway.example" };
const keys = () => new KeyStore(kit.fetch, () => clock.now);
const check = async (token: string | null, k = keys(), s = SETTINGS) => await checkAccessToken(token, s, k, clock.now);
const why = (r: Awaited<ReturnType<typeof check>>) => (r.ok ? "ok" : r.why);

// ---------- settings ----------
ok("the team domain is taken with or without https:// and a trailing slash", teamHost("https://Team.Example.cloudflareaccess.com/") === "team.example.cloudflareaccess.com" && teamHost("team.example.cloudflareaccess.com") === "team.example.cloudflareaccess.com");
ok("a team domain with a space, a port, http:// or nothing in it is refused", [teamHost("team example.com"), teamHost("team.example.com:8443"), teamHost(""), teamHost("   "), teamHost(undefined), teamHost("http://team.example.com"), teamHost("-team"), teamHost("https://")].every((v) => v === null));
ok("a pasted sign-in address keeps only the host; quotes are dropped; the team name alone gets .cloudflareaccess.com",
  teamHost("https://team.cloudflareaccess.com/cdn-cgi/access/login/snl.example?kid=abc#x") === "team.cloudflareaccess.com" && teamHost("team.example.com/x") === "team.example.com"
  && teamHost('"team.cloudflareaccess.com"') === "team.cloudflareaccess.com" && teamHost("'Team.cloudflareaccess.com' ") === "team.cloudflareaccess.com"
  && teamHost("my-team") === "my-team.cloudflareaccess.com" && teamHost(" MyTeam ") === "myteam.cloudflareaccess.com");
ok("several audiences are read, comma-separated", JSON.stringify(accessSettings(env({ CF_ACCESS_TEAM_DOMAIN: kit.team, CF_ACCESS_AUD: " a1, ,a2 " }))?.auds) === '["a1","a2"]');
ok("without the team domain or the audience there are no settings", accessSettings(env({ CF_ACCESS_AUD: "a" })) === null && accessSettings(env({ CF_ACCESS_TEAM_DOMAIN: kit.team })) === null && accessSettings(env({ CF_ACCESS_TEAM_DOMAIN: kit.team, CF_ACCESS_AUD: " , " })) === null);

// ---------- the admin list ----------
const R = (list: string | undefined, email: string) => roleFor(email, env(list === undefined ? {} : { SNL_ADMIN_EMAILS: list }));
ok("an address on the admin list is Corp Dev, in any letter case and with spaces around it", R(" Owner@Calloway.example ,second@calloway.example", "owner@calloway.EXAMPLE") === "corpdev" && R("owner@calloway.example", " Owner@calloway.example ") === "corpdev");
ok("an address not on the list is a reader", R("owner@calloway.example", "jane.doe@calloway.example") === "reader");
ok("an empty or missing list means nobody is an admin", R("", "owner@calloway.example") === "reader" && R(undefined, "owner@calloway.example") === "reader" && R(" , ", "owner@calloway.example") === "reader" && adminEmails(" , ").size === 0);
ok("part of an address doesn't count", R("owner@calloway.example", "wner@calloway.example") === "reader" && R("owner@calloway.example", "owner@calloway.example.evil") === "reader");

// ---------- names ----------
ok("a display name is made from the address", displayNameFrom("jane.doe@calloway.example") === "Jane Doe" && displayNameFrom("j_smith-jones+snl@calloway.example") === "J Smith Jones");
ok("a username fits the profiles table", ["jane.doe@calloway.example", "J@calloway.example", "O'Brien+x@calloway.example", "a".repeat(80) + "@calloway.example", "--@calloway.example"].map((e) => usernameBase(e)).every((u) => /^[a-z0-9._-]{2,40}$/.test(u)), ["jane.doe@calloway.example", "J@calloway.example", "O'Brien+x@calloway.example", "--@calloway.example"].map(usernameBase));
ok("emails are lower-cased and checked for shape", cleanEmail(" Jane@Calloway.Example ") === "jane@calloway.example" && [null, 5, "", "jane", "jane@", "a b@c.d", "x@y", "<a@b.c>"].every((v) => cleanEmail(v) === null));

// ---------- the token ----------
ok("a good token passes and gives the verified email", JSON.stringify(await check(await kit.token())) === JSON.stringify({ ok: true, email: "jane.doe@calloway.example", sub: "00000000-made-up-sub" }));
ok("an audience given as a plain string passes", why(await check(await kit.token({ claims: { aud: kit.aud } }))) === "ok");
ok("any one of several configured audiences passes", why(await check(await kit.token(), keys(), { team: kit.team, auds: ["other", kit.aud] })) === "ok");
ok("a token for another application is refused", why(await check(await kit.token({ claims: { aud: ["aud-someone-else"] } }))) === "audience" && why(await check(await kit.token({ claims: { aud: [] } }))) === "audience" && why(await check(await kit.token({ drop: ["aud"] }))) === "audience");
ok("a token from another team is refused", why(await check(await kit.token({ claims: { iss: "https://other.cloudflareaccess.com" } }))) === "issuer" && why(await check(await kit.token({ claims: { iss: kit.team } }))) === "issuer" && why(await check(await kit.token({ drop: ["iss"] }))) === "issuer");
ok("an expired token is refused, to the second", why(await check(await kit.token({ claims: { exp: SEC - 1 } }))) === "expired" && why(await check(await kit.token({ claims: { exp: SEC } }))) === "expired" && why(await check(await kit.token({ drop: ["exp"] }))) === "expired" && why(await check(await kit.token({ claims: { exp: String(SEC + 60) } }))) === "expired");
ok("a token not valid yet is refused (30 seconds of clock difference allowed)", why(await check(await kit.token({ claims: { nbf: SEC + 120 } }))) === "early" && why(await check(await kit.token({ claims: { nbf: SEC + 20 } }))) === "ok" && why(await check(await kit.token({ claims: { nbf: "soon" } }))) === "early");
ok("only RS256: none, HS256, RS512 and a missing algorithm are refused", (await Promise.all(["none", "HS256", "RS512", "PS256", "rs256"].map(async (alg) => why(await check(await kit.token({ header: { alg } })))))).every((w) => w === "algorithm") && why(await check(await kit.token({ header: { alg: undefined } }))) === "algorithm");
{
  // alg none with no signature, and an HS256 token signed with the public key as its secret (the classic confusion)
  const head = (h: unknown) => btoa(JSON.stringify(h)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const good = await kit.token(), body = good.split(".")[1];
  ok("an unsigned token (alg none) is refused", why(await check(head({ alg: "none", kid: "kid-made-up-1" }) + "." + body + ".")) === "malformed" && why(await check(head({ alg: "none", kid: "kid-made-up-1" }) + "." + body + ".AAAA")) === "algorithm");
  const jwk = (await kit.certs()).keys[0];
  const hk = await crypto.subtle.importKey("raw", new TextEncoder().encode(JSON.stringify(jwk)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hhead = head({ alg: "HS256", kid: "kid-made-up-1" }) + "." + body;
  const hsig = new Uint8Array(await crypto.subtle.sign("HMAC", hk, new TextEncoder().encode(hhead)));
  ok("an HS256 token keyed with the public key is refused", why(await check(hhead + "." + btoa(String.fromCharCode(...hsig)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"))) === "algorithm");
  // a payload changed after signing
  const p = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  const forged = btoa(JSON.stringify({ ...p, email: "owner@calloway.example" })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const [h0, , s0] = good.split(".");
  ok("a payload changed after signing is refused", why(await check(`${h0}.${forged}.${s0}`)) === "signature");
  ok("a signature changed by one character is refused", why(await check(`${h0}.${body}.${(s0[0] === "A" ? "B" : "A") + s0.slice(1)}`)) === "signature");
  const other = await accessTeam();   // the same kid, another team's private key
  ok("a token signed with someone else's key under a known key id is refused", why(await check(await other.token())) === "signature");
}
ok("malformed tokens of every kind are refused before any key is fetched", await (async () => {
  const k = keys(), before = kit.certCalls;
  const bad = [null, "", "abc", "a.b", "a.b.c.d", "...", "!!.!!.!!", `${btoa("{")}.${btoa("{}")}.AAAA`, `${btoa('"text"')}.${btoa("{}")}.AAAA`, `${btoa("[]")}.${btoa("{}")}.AAAA`, `${btoa(JSON.stringify({ alg: "RS256", kid: "k" }))}.${btoa("null")}.AAAA`, `${btoa(JSON.stringify({ alg: "RS256", kid: "k" }))}.${btoa("{}")}.`, "x".repeat(20000)];
  const out = await Promise.all(bad.map((t) => check(t, k)));
  return out.every((r) => !r.ok && (r.why === "malformed" || r.why === "missing")) && kit.certCalls === before;
})());
ok("a token with no key id, or a key id that isn't text, is refused", why(await check(await kit.token({ header: { kid: undefined } }))) === "malformed" && why(await check(await kit.token({ header: { kid: 7 } }))) === "malformed");
ok("a service token (no email) is refused, after its signature is checked", why(await check(await kit.token({ drop: ["email"] }))) === "no_email" && why(await check(await kit.token({ claims: { email: "" } }))) === "no_email" && why(await check(await kit.token({ claims: { email: ["a@b.c"] } }))) === "no_email");

// ---------- the keys: cached, fetched again for a new key id, refused when unreachable ----------
{
  const before = kit.certCalls, k = keys();
  await check(await kit.token(), k); await check(await kit.token(), k); await check(await kit.token(), k);
  ok("the keys are fetched once and reused", kit.certCalls - before === 1);
  await kit.addKey("kid-made-up-2", false);   // Cloudflare rotates: a new key signs, not yet in the set this store holds
  ok("a token signed by a key not published yet is refused", why(await check(await kit.token({ kid: "kid-made-up-2" }), k)) === "key");
  kit.published.push("kid-made-up-2");
  ok("straight after a fetch, an unknown key id doesn't fetch again (no flood)", why(await check(await kit.token({ kid: "kid-made-up-2" }), k)) === "key" && kit.certCalls - before === 1);
  clock.now += 11_000;
  const rotated = await check(await kit.token({ kid: "kid-made-up-2", nowSec: Math.floor(clock.now / 1000) }), k);
  ok("once published, the new key is fetched and the token passes", rotated.ok && kit.certCalls - before === 2, rotated);
  ok("the old key still works too (Cloudflare keeps both for 7 days)", why(await check(await kit.token({ nowSec: Math.floor(clock.now / 1000) }), k)) === "ok" && kit.certCalls - before === 2);
  clock.now += 3601_000;
  await check(await kit.token({ nowSec: Math.floor(clock.now / 1000) }), k);
  ok("after an hour the keys are fetched again", kit.certCalls - before === 3);
  kit.published.splice(kit.published.indexOf("kid-made-up-2"), 1);
  clock.now = NOW;
}
{
  kit.certsDown = true;
  ok("when the keys can't be fetched, nothing passes", why(await check(await kit.token())) === "keys_unavailable");
  kit.certsDown = false;
  const throwing = new KeyStore((async () => { throw new TypeError("network down"); }) as unknown as typeof fetch, () => clock.now);
  ok("a network failure fetching the keys refuses too", why(await check(await kit.token(), throwing)) === "keys_unavailable");
  const junk = new KeyStore((async () => J({ nope: true })) as unknown as typeof fetch, () => clock.now);
  ok("a keys answer without keys refuses", why(await check(await kit.token(), junk)) === "keys_unavailable");
  const nonRsa = new KeyStore((async () => J({ keys: [{ kid: "kid-made-up-1", kty: "EC", x: "a", y: "b" }] })) as unknown as typeof fetch, () => clock.now);
  ok("a key that isn't RSA is never used", why(await check(await kit.token(), nonRsa)) === "key");
}

// ---------- signIn: users, profiles, roles, the session ----------
const signin = async (token: string | null, store = memorySignin(clock), e: Record<string, string> = ENV) => ({ store, r: await silently(() => signIn(token, { env: env(e), store, keys: keys(), now: clock.now })) });
{
  const { store, r } = await signin(await kit.token());
  const u = store.byEmail("jane.doe@calloway.example");
  ok("first sign-in: a confirmed user is created with that email and a password nobody was given", !!u && u.confirmed && u.password.length >= 32 && u.password !== "old");
  ok("first sign-in: a reader profile with a username and display name from the address", JSON.stringify(store.profiles.get(u!.id)) === JSON.stringify({ id: u!.id, username: "jane.doe", display_name: "Jane Doe", role: "reader" }), [...store.profiles.values()]);
  ok("the answer carries only the access token, its expiry and the profile", r.status === 200 && JSON.stringify(Object.keys(r.body).sort()) === '["accessToken","expiresAt","expiresIn","profile"]' && r.body.accessToken === store.minted[0].accessToken && r.body.expiresAt === SEC + 3600 && r.body.expiresIn === 3600, r);
  ok("the profile in the answer says who and what role", JSON.stringify(r.body.profile) === JSON.stringify({ id: u!.id, email: "jane.doe@calloway.example", username: "jane.doe", displayName: "Jane Doe", role: "reader" }));
  ok("the refresh token is nowhere in the answer", !JSON.stringify(r).includes("refresh") && !JSON.stringify(r).includes("SECRET"));
  const again = await signIn(await kit.token(), { env: env(ENV), store, keys: keys(), now: clock.now });
  ok("second sign-in: the same user, no new user, no profile write when nothing changed", again.status === 200 && store.users.size === 1 && (again.body.profile as any).id === u!.id && store.log.filter((l) => l === "saveProfile").length === 1, store.log);
}
{
  const store = memorySignin(clock);
  const owner = store.addUser("owner@calloway.example", "00000000-0000-4000-8000-0000000000aa");
  store.profiles.set(owner.id, { id: owner.id, username: "corpdev1", display_name: "Corp Dev 1", role: "reader" });
  const { r } = await signin(await kit.token({ claims: { email: "OWNER@calloway.example" } }), store);
  ok("an address on the admin list lands on its existing user and becomes Corp Dev", r.status === 200 && (r.body.profile as any).id === owner.id && store.profiles.get(owner.id)!.role === "corpdev" && store.users.size === 1);
  ok("the existing username and display name are kept", store.profiles.get(owner.id)!.username === "corpdev1" && store.profiles.get(owner.id)!.display_name === "Corp Dev 1");
  const { r: down } = await signin(await kit.token({ claims: { email: "owner@calloway.example" } }), store, { ...ENV, SNL_ADMIN_EMAILS: "someone.else@calloway.example" });
  ok("taken off the list, the same person is a reader at the next sign-in", down.status === 200 && store.profiles.get(owner.id)!.role === "reader" && (down.body.profile as any).role === "reader");
  const { r: none } = await signin(await kit.token({ claims: { email: "owner@calloway.example" } }), store, { ...ENV, SNL_ADMIN_EMAILS: "" });
  ok("with an empty admin list, nobody is Corp Dev", none.status === 200 && store.profiles.get(owner.id)!.role === "reader");
}
{
  const store = memorySignin(clock);
  const other = store.addUser("jane.doe@other.example");
  store.profiles.set(other.id, { id: other.id, username: "jane.doe", display_name: "Jane Doe", role: "reader" });
  const { r } = await signin(await kit.token(), store);
  ok("a username already taken by someone else gets a number", r.status === 200 && (r.body.profile as any).username === "jane.doe-2");
  const lone = store.addUser("lone@calloway.example");
  const { r: r2 } = await signin(await kit.token({ claims: { email: "lone@calloway.example" } }), store);
  ok("a user with no profile yet gets one", r2.status === 200 && store.profiles.get(lone.id)?.username === "lone" && store.users.size === 3);
  store.profiles.set(lone.id, { ...store.profiles.get(lone.id)!, display_name: "" });
  await upkeepProfile(store as any, lone.id, "lone@calloway.example", "reader");
  ok("a blank display name is filled in", store.profiles.get(lone.id)!.display_name === "Lone");
}
{
  const { store, r } = await signin(await kit.token(), memorySignin(clock), { SNL_ADMIN_EMAILS: "x@calloway.example" });
  ok("settings missing: says sign-in isn't set up yet, and mints nothing", r.status === 503 && r.body.error === "not_configured" && r.body.message === MSG.notSetUp && store.minted.length === 0 && store.users.size === 0 && store.log.length === 0);
  const tk = await kit.token();
  const r2 = await silently(() => signIn(tk, { env: env(ENV), store: null, keys: keys(), now: clock.now }));
  ok("outside Supabase (no store): the same plain message", r2.status === 503 && r2.body.error === "not_configured");
  ok("the not-set-up message is plain English", /^Cloudflare let you in, but sign-in isn't set up on Supabase yet\./.test(MSG.notSetUp) && !/—/.test(Object.values(MSG).join(" ")));
}
for (const [label, token, status, error] of [
  ["no token", null, 401, "signin"], ["an expired token", await kit.token({ claims: { exp: SEC - 5 } }), 401, "signin"],
  ["a token for another application", await kit.token({ claims: { aud: ["nope"] } }), 401, "signin"], ["a service token", await kit.token({ drop: ["email"] }), 403, "no_email"],
] as const) {
  const { store, r } = await signin(token, memorySignin(clock));
  ok(`${label}: refused with a plain message, and nothing is created or minted`, r.status === status && r.body.error === error && typeof r.body.message === "string" && store.log.length === 0 && store.minted.length === 0, r);
}
{
  kit.certsDown = true;
  const { store, r } = await signin(await kit.token());
  kit.certsDown = false;
  ok("Cloudflare's keys unreachable: 503, a plain message, nothing minted", r.status === 503 && r.body.error === "unavailable" && r.body.message === MSG.keys && store.minted.length === 0);
}
for (const f of ["create", "mint", "profile", "save"] as const) {
  const store = memorySignin(clock); store.fail = f;
  const token = await kit.token();
  const r = await silently(() => signIn(token, { env: env(ENV), store, keys: keys(), now: clock.now }));
  const said = ((silently as any).said as string[]).join("\n");
  ok(`a Supabase failure (${f}) answers 500 with a plain message, without the error text, the token or the address`, r.status === 500 && r.body.message === MSG.server && !JSON.stringify(r.body).includes("made-up") && !said.includes(token) && !said.includes("calloway"), { r, said });
}
{
  const token = await kit.token({ claims: { exp: SEC - 1 } });
  await signin(token);
  const said = ((silently as any).said as string[]).join("\n");
  ok("a refusal logs only its reason: never the token or the address", said === "snl-signin: refused (expired)", said);
}

// ---------- the function ----------
{
  const store = memorySignin(clock);
  const call = async (r: Request, e = ENV): Promise<{ res: Response; body: any }> => { const res: Response = await silently(() => fn.handle(r, { env: env(e), fetch: kit.fetch, now: () => clock.now, store, keys: keys() })); return { res, body: await res.json().catch(() => null) }; };
  const post = (headers: Record<string, string>, body: unknown = { action: "session" }) => new Request("https://x.supabase.co/functions/v1/snl-signin", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const good = await call(post({ "Cf-Access-Jwt-Assertion": await kit.token() }));
  ok("snl-signin: the token in Cf-Access-Jwt-Assertion gives a session, never cached", good.res.status === 200 && typeof good.body.accessToken === "string" && good.res.headers.get("Cache-Control") === "no-store" && !JSON.stringify(good.body).includes("refresh"), good.body);
  ok("snl-signin: an empty body works too", (await call(post({ "Cf-Access-Jwt-Assertion": await kit.token() }, {}))).res.status === 200);
  ok("snl-signin: a token in the Authorization header is not looked at", (await call(post({ Authorization: "Bearer " + await kit.token() }))).res.status === 401);
  ok("snl-signin: an unknown action is refused", (await call(post({ "Cf-Access-Jwt-Assertion": await kit.token() }, { action: "mint_for", email: "owner@calloway.example" }))).res.status === 400);
  ok("snl-signin: GET is refused", (await call(new Request("https://x.supabase.co/functions/v1/snl-signin", { method: "GET", headers: { "Cf-Access-Jwt-Assertion": await kit.token() } }))).res.status === 405);
  const unset = await call(post({ "Cf-Access-Jwt-Assertion": await kit.token() }), {} as any);
  ok("snl-signin: without its settings, not set up yet", unset.res.status === 503 && unset.body.error === "not_configured");
}

// ---------- the real store: the calls supabase-js 2.119.0 makes, against a stand-in for Supabase Auth and the database ----------
{
  const calls: { method: string; path: string; auth: string; body: any }[] = [];
  const users = new Map<string, { id: string; email: string }>();
  const profiles = new Map<string, any>();
  const fake = (async (input: Request | URL | string, init?: RequestInit) => {
    const r = input instanceof Request ? input : new Request(String(input), init);
    const u = new URL(r.url), body = r.method === "GET" || r.method === "HEAD" ? null : await r.text().then((t) => (t ? JSON.parse(t) : null));
    calls.push({ method: r.method, path: u.pathname + u.search, auth: r.headers.get("authorization") ?? "", body });
    const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/auth/v1/admin/users" && r.method === "POST") {
      if ([...users.values()].some((x) => x.email === body.email)) return j({ code: "email_exists", msg: "A user with this email address has already been registered", error_code: "email_exists" }, 422);
      const id = `00000000-0000-4000-8000-${String(users.size + 1).padStart(12, "0")}`; users.set(id, { id, email: body.email }); return j({ id, email: body.email });
    }
    if (u.pathname === "/auth/v1/admin/generate_link") {
      const x = [...users.values()].find((y) => y.email === body.email);
      return j({ id: x!.id, email: x!.email, action_link: "https://x.supabase.co/auth/v1/verify?token=made-up", email_otp: "000000", hashed_token: "hash-" + x!.id, redirect_to: "", verification_type: "magiclink" });
    }
    if (u.pathname === "/auth/v1/verify") {
      const id = String(body.token_hash).replace(/^hash-/, "");
      return j({ access_token: "access-" + id, token_type: "bearer", expires_in: 3600, expires_at: SEC + 3600, refresh_token: "refresh-SECRET", user: { id, email: users.get(id)!.email } });
    }
    if (u.pathname === "/rest/v1/profiles" && r.method === "GET") {
      const [col, val] = [...u.searchParams.entries()].find(([k]) => k === "id" || k === "username")!;
      const row = [...profiles.values()].find((p) => p[col] === val.replace(/^eq\./, ""));
      return row ? j(r.headers.get("accept")?.includes("vnd.pgrst.object") ? row : [row]) : (r.headers.get("accept")?.includes("vnd.pgrst.object") ? j({ code: "PGRST116", message: "0 rows" }, 406) : j([]));
    }
    if (u.pathname === "/rest/v1/profiles" && r.method === "POST") { profiles.set(body.id, body); return j([], 201); }
    return j({ message: "no stand-in for " + r.method + " " + u.pathname }, 404);
  }) as unknown as typeof fetch;
  const real = supabaseSigninStore(env({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key-made-up" }), fake, () => clock.now)!;
  ok("the real store needs Supabase's own address and service key", supabaseSigninStore(env({}), fake) === null && !!real);
  const r = await silently(() => signIn(null, { env: env(ENV), store: real, keys: keys(), now: clock.now }));
  ok("(a refused token makes no call to Supabase)", r.status === 401 && calls.length === 0);
  const ok1 = await silently(async () => signIn(await kit.token(), { env: env(ENV), store: real, keys: keys(), now: clock.now }));
  const create = calls.find((c) => c.path === "/auth/v1/admin/users");
  ok("real store: creates the user confirmed, with a long random password", ok1.status === 200 && create?.body.email === "jane.doe@calloway.example" && create?.body.email_confirm === true && typeof create?.body.password === "string" && create.body.password.length >= 60, { ok1, create });
  const gen = calls.find((c) => c.path === "/auth/v1/admin/generate_link"), ver = calls.find((c) => c.path.startsWith("/auth/v1/verify"));
  ok("real store: an admin magic link is generated (no email is sent by this call) and its hash verified", gen?.body.type === "magiclink" && gen?.body.email === "jane.doe@calloway.example" && ver?.body.token_hash === "hash-00000000-0000-4000-8000-000000000001" && ver?.body.type === "email", { gen, ver });
  ok("real store: the session is the verified one, without its refresh token", ok1.body.accessToken === "access-00000000-0000-4000-8000-000000000001" && ok1.body.expiresAt === SEC + 3600 && !JSON.stringify(ok1).includes("refresh"));
  const after = calls.slice(calls.indexOf(ver!) + 1);
  ok("real store: database calls after verifying still use the service key, not the user's session", after.length > 0 && after.every((c) => c.auth === "Bearer service-key-made-up"), after.map((c) => [c.path, c.auth]));
  ok("real store: the profile is written with the username and role", JSON.stringify(profiles.get("00000000-0000-4000-8000-000000000001")) === JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", username: "jane.doe", display_name: "Jane Doe", role: "reader" }));
  calls.length = 0;
  const ok2 = await silently(async () => signIn(await kit.token(), { env: env(ENV), store: real, keys: keys(), now: clock.now }));
  ok("real store: an existing user (create answers 422 email_exists) is used as is", ok2.status === 200 && users.size === 1 && ok2.body.accessToken === ok1.body.accessToken && !calls.some((c) => c.path === "/rest/v1/profiles" && c.method === "POST"));
}

done();
