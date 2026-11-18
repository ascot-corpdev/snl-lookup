// scripts/logins.mjs, the two commands for moving to Cloudflare sign-on: link (point an existing login at a real
// email address, so the first Cloudflare sign-in lands on it) and retire-passwords (remove the logins on made-up
// addresses and give the rest a password nobody knows). Against a stand-in for Supabase on this machine only;
// every name and address is made up.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../scripts/logins.mjs");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail)); } };

const users = new Map(), profiles = new Map(), log = [];
const addUser = (id, email, username, role) => { users.set(id, { id, email, password: "known-" + id, confirmed: true }); if (username) profiles.set(id, { id, username, display_name: username, role, created_at: "2026-11-13T12:00:00Z" }); };
function reset() {
  users.clear(); profiles.clear(); log.length = 0;
  addUser("00000000-0000-4000-8000-000000000001", "corpdev1@snl-lookup.local", "corpdev1", "corpdev");
  addUser("00000000-0000-4000-8000-000000000002", "corpdev2@snl-lookup.local", "corpdev2", "corpdev");
  addUser("00000000-0000-4000-8000-000000000003", "jane.doe@calloway.example", "jane.doe", "reader");
}
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x"), body = raw ? JSON.parse(raw) : null;
    log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const send = (status, doc) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(doc)); };
    const view = (u) => ({ id: u.id, email: u.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-11-13T12:00:00Z" });
    if (url.pathname === "/auth/v1/admin/users" && req.method === "GET") {
      const page = +url.searchParams.get("page") || 1, per = +url.searchParams.get("per_page") || 50;
      return send(200, { users: [...users.values()].slice((page - 1) * per, page * per).map(view), aud: "authenticated" });
    }
    const one = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
    if (one && req.method === "GET") return users.has(one[1]) ? send(200, view(users.get(one[1]))) : send(404, { msg: "User not found" });
    if (one && req.method === "PUT") {
      const u = users.get(one[1]);
      if (body.email && [...users.values()].some((x) => x.email === body.email && x.id !== u.id)) return send(422, { code: "email_exists", error_code: "email_exists", msg: "A user with this email address has already been registered" });
      if (body.email) u.email = body.email;
      if (body.password) u.password = body.password;
      return send(200, view(u));
    }
    if (one && req.method === "DELETE") { users.delete(one[1]); profiles.delete(one[1]); return send(200, {}); }
    if (url.pathname === "/rest/v1/profiles" && req.method === "GET") {
      const want = (url.searchParams.get("username") || "").replace(/^eq\./, "");
      const rows = [...profiles.values()].filter((p) => !want || p.username === want);
      const single = (req.headers.accept || "").includes("vnd.pgrst.object");
      return single ? (rows.length ? send(200, rows[0]) : send(406, { code: "PGRST116", details: "0 rows", message: "no rows" })) : send(200, rows);
    }
    send(404, { message: "no stand-in for " + req.method + " " + url.pathname });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, SUPABASE_URL: base, SUPABASE_SECRET_KEY: "test-secret-key" } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  child.on("close", (status) => resolve({ status, out }));
});
const U1 = "00000000-0000-4000-8000-000000000001", U2 = "00000000-0000-4000-8000-000000000002", U3 = "00000000-0000-4000-8000-000000000003";

// ---- usage
reset();
const usage = await run([]);
ok("the usage line names the two new commands", usage.status === 0 && usage.out.includes("link <username> <email>") && usage.out.includes("retire-passwords [--apply]"), usage.out);

// ---- link
const linked = await run(["link", "corpdev1", " Owner@Calloway.Example "]);
ok("link points the login at the real address, lower-cased and confirmed", linked.status === 0 && users.get(U1).email === "owner@calloway.example" && log.some((l) => l.method === "PUT" && l.body?.email === "owner@calloway.example" && l.body?.email_confirm === true), linked.out);
ok("link keeps the same user, so history stays with it, and says so", users.has(U1) && profiles.get(U1)?.username === "corpdev1" && /keep this login's past answers, recent searches and saved things/.test(linked.out));
ok("link says the password still works on the GitHub Pages copy until retired, with the address as the username", /can still sign in to the GitHub Pages copy, now with owner@calloway\.example in the username box/.test(linked.out));
ok("link doesn't touch the password", users.get(U1).password === "known-" + U1);
const again = await run(["link", "corpdev1", "owner@calloway.example"]);
ok("linking again to the same address changes nothing", again.status === 0 && /already linked/.test(again.out) && log.filter((l) => l.method === "PUT").length === 1);
const taken = await run(["link", "corpdev2", "jane.doe@calloway.example"]);
ok("an address another login already has is refused with what to do, and nothing changes", taken.status === 1 && /Another login already has jane\.doe@calloway\.example/.test(taken.out) && users.get(U2).email === "corpdev2@snl-lookup.local", taken.out);
for (const [args, re] of [[["link", "nobody", "x@calloway.example"], /No login called "nobody"/], [["link", "corpdev2", "not-an-address"], /is not an email address/], [["link", "corpdev2"], /is not an email address/], [["link", "corpdev2", "corpdev9@snl-lookup.local"], /made-up login address/], [["link", "Bad Name", "x@calloway.example"], /is not a valid username/]]) {
  const before = log.filter((l) => l.method === "PUT").length;
  const r = await run(args);
  ok(`link refuses ${JSON.stringify(args.slice(1))} and changes nothing`, r.status === 1 && re.test(r.out) && log.filter((l) => l.method === "PUT").length === before, r.out);
}

// ---- retire-passwords
const putsBefore = log.filter((l) => l.method === "PUT").length;
const dry = await run(["retire-passwords"]);
ok("retire-passwords without --apply only shows what it would do", dry.status === 0 && /corpdev2/.test(dry.out) && !/corpdev1\b.*snl-lookup/.test(dry.out) && /Nothing changed\. Run again with --apply/.test(dry.out) && users.size === 3 && !log.some((l) => l.method === "DELETE") && log.filter((l) => l.method === "PUT").length === putsBefore, dry.out);
ok("it counts the logins with real addresses that keep everything", /2 logins with a real email address keep everything/.test(dry.out));
const done_ = await run(["retire-passwords", "--apply"]);
ok("with --apply: the login still on a made-up address is removed", done_.status === 0 && !users.has(U2) && !profiles.has(U2), done_.out);
ok("with --apply: the linked and Cloudflare logins stay, each with a new long password nobody was shown", users.has(U1) && users.has(U3) && users.get(U1).password !== "known-" + U1 && users.get(U3).password !== "known-" + U3 && users.get(U1).password.length >= 60 && !done_.out.includes(users.get(U1).password) && !done_.out.includes(users.get(U3).password));
ok("with --apply: it says how to end password sessions already open", /delete from auth\.sessions;/.test(done_.out));
ok("it uses the secret key and only Supabase's own addresses", log.every((l) => l.path.startsWith("/auth/v1/") || l.path.startsWith("/rest/v1/")));
const after = await run(["retire-passwords"]);
ok("run again, nothing is left on a made-up address", /No logins are left on made-up addresses/.test(after.out));

server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
