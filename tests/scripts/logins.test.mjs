// scripts/logins.mjs against a stand-in for Supabase's auth admin and database addresses, on this machine only.
// Every login name here is made up, and nothing touches a real project.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../scripts/logins.mjs");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail)); } };

// ---- a tiny stand-in for Supabase: users and profiles in memory
const users = new Map(), profiles = new Map(), log = [];
let seq = 0;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x"), body = raw ? JSON.parse(raw) : null;
    log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, key: req.headers.apikey });
    const send = (status, doc) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(doc)); };
    if (url.pathname === "/auth/v1/admin/users" && req.method === "POST") {
      if (!/@snl-lookup\.local$/.test(body.email)) return send(422, { msg: "invalid email" });
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      users.set(id, { id, email: body.email, password: body.password, confirmed: body.email_confirm });
      return send(200, { id, email: body.email, user_metadata: body.user_metadata });
    }
    const one = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
    if (one && req.method === "GET") return users.has(one[1]) ? send(200, { id: one[1], email: users.get(one[1]).email }) : send(404, { msg: "User not found" });
    if (one && req.method === "PUT") { users.get(one[1]).password = body.password; return send(200, { id: one[1] }); }
    if (one && req.method === "DELETE") { users.delete(one[1]); for (const [u, p] of profiles) if (p.id === one[1]) profiles.delete(u); return send(200, {}); }
    if (url.pathname === "/rest/v1/profiles" && req.method === "GET") {
      const want = (url.searchParams.get("username") || "").replace(/^eq\./, "");
      const rows = [...profiles.values()].filter((p) => !want || p.username === want);
      const single = (req.headers.accept || "").includes("vnd.pgrst.object");
      return single ? (rows.length ? send(200, rows[0]) : send(406, { code: "PGRST116", details: "0 rows", message: "no rows" })) : send(200, rows);
    }
    if (url.pathname === "/rest/v1/profiles" && req.method === "POST") {
      if (!["corpdev", "reader"].includes(body.role)) return send(400, { message: "violates check constraint" });
      profiles.set(body.username, { ...body, created_at: "2026-11-13T12:00:00Z" });
      return send(201, []);
    }
    send(404, { message: "no stand-in for " + req.method + " " + url.pathname });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
// spawnSync would block this process's own server, so run each command through a short async wrapper
const { spawn } = await import("node:child_process");
const run = (args, env = { SUPABASE_URL: base + "/rest/v1/", SUPABASE_SECRET_KEY: "test-secret-key" }) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  child.on("close", (status) => resolve({ status, out }));
});

// ---- no key: says what to set, and does nothing
const none = await run(["list"], {});
ok("without the address and secret key it stops and says what to set", none.status === 1 && /Set SUPABASE_URL and SUPABASE_SECRET_KEY first/.test(none.out) && log.length === 0, none);
const usage = await run([]);
ok("with no command it prints how to use it", usage.status === 0 && /seed \| add <username> <corpdev\|reader>/.test(usage.out), usage.out);

// ---- seed
const seed = await run(["seed"]);
ok("seed creates corpdev1 and corpdev2 as Corp Dev logins", seed.status === 0 && [...profiles.keys()].join() === "corpdev1,corpdev2" && [...profiles.values()].every((p) => p.role === "corpdev"), [...profiles.values()]);
ok("each login is a confirmed e-mail of the form username@snl-lookup.local", [...users.values()].map((u) => u.email).join() === "corpdev1@snl-lookup.local,corpdev2@snl-lookup.local" && [...users.values()].every((u) => u.confirmed === true));
const shown = [...seed.out.matchAll(/[A-Za-z2-9]{6}-[A-Za-z2-9]{6}-[A-Za-z2-9]{6}/g)].map((m) => m[0]);
ok("a random password is printed once for each, and it is the one set", shown.length === 2 && shown[0] !== shown[1] && [...users.values()].every((u) => shown.includes(u.password)), seed.out);
ok("it uses the secret key and trims the address it was given", log.every((l) => l.key === "test-secret-key") && log.every((l) => !l.path.startsWith("/rest/v1/rest")));
const again = await run(["seed"]);
ok("running seed again creates nothing new and says the logins exist", again.status === 0 && users.size === 2 && /already exists \(use reset\)/.test(again.out), again.out);

// ---- add, reset, list, remove
const reader = await run(["add", "reader1", "reader", "Reader One"]);
ok("add creates a reader login with its display name", reader.status === 0 && profiles.get("reader1")?.role === "reader" && profiles.get("reader1")?.display_name === "Reader One", profiles.get("reader1"));
const badRole = await run(["add", "boss", "ceo", "The Boss"]);
ok("a role other than corpdev or reader is refused before anything is created", badRole.status === 1 && /Role must be "corpdev" or "reader"/.test(badRole.out) && !profiles.has("boss") && users.size === 3, badRole.out);
const badName = await run(["add", "Not A Name", "reader", "X"]);
ok("a username with spaces or capitals is refused", badName.status === 1 && /is not a valid username/.test(badName.out) && users.size === 3, badName.out);
const before = [...users.values()].find((u) => u.email.startsWith("reader1@")).password;
const reset = await run(["reset", "reader1"]);
const after = [...users.values()].find((u) => u.email.startsWith("reader1@")).password;
ok("reset gives the login a new password and prints it", reset.status === 0 && after !== before && reset.out.includes(after), reset.out);
const missing = await run(["reset", "nobody"]);
ok("reset of a login that doesn't exist says so", missing.status === 1 && /No login called "nobody"/.test(missing.out), missing.out);
const list = await run(["list"]);
ok("list shows every login with its role, and no passwords", list.status === 0 && ["corpdev1", "corpdev2", "reader1"].every((u) => list.out.includes(u)) && !list.out.includes(after) && !shown.some((p) => list.out.includes(p)), list.out);
const removed = await run(["remove", "reader1"]);
ok("remove deletes the login", removed.status === 0 && !profiles.has("reader1") && users.size === 2 && /Removed reader1/.test(removed.out), removed.out);

server.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
