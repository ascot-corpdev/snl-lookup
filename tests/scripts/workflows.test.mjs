// The shell steps in the two workflows that write the site's settings and keep Supabase awake, run on this
// machine against made-up values and a local stand-in. Nothing touches GitHub or a real project.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log("FAIL " + name, JSON.stringify(detail)); } };

/** The shell under the first "run: |" of a workflow file, with its indentation removed. */
function runBlock(file) {
  const lines = readFileSync(join(here, "../../.github/workflows", file), "utf8").split("\n");
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  const indent = lines[at].match(/^\s*/)[0].length + 2;
  const out = [];
  for (const l of lines.slice(at + 1)) { if (l.trim() && l.match(/^\s*/)[0].length < indent) break; out.push(l.slice(indent)); }
  return out.join("\n");
}
const sh = (script, env, cwd) => new Promise((resolve) => {
  const child = spawn("bash", ["-e", "-c", script], { cwd, env: { PATH: process.env.PATH, ...env } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  child.on("close", (status) => resolve({ status, out }));
});

// ---------- pages.yml: writing web/config.js ----------
{
  const script = runBlock("pages.yml");
  const dir = mkdtempSync(join(tmpdir(), "snl-pages-"));
  mkdirSync(join(dir, "web"));
  const config = () => { const window = {}; new Function("window", readFileSync(join(dir, "web/config.js"), "utf8"))(window); return window.SNL_CONFIG; };

  const good = await sh(script, { SUPABASE_URL: " https://abcdefgh.supabase.co/rest/v1/ ", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_madeup", USERNAME_DOMAIN: "" }, dir);
  ok("the settings file is written from the repository variables", good.status === 0 && existsSync(join(dir, "web/config.js")), good.out);
  ok("the address is tidied to the project address alone, and the login domain defaults to snl-lookup.local", JSON.stringify(config()) === JSON.stringify({ supabaseUrl: "https://abcdefgh.supabase.co", supabaseAnonKey: "sb_publishable_madeup", usernameDomain: "snl-lookup.local" }), config());
  const domain = await sh(script, { SUPABASE_URL: "https://abcdefgh.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_madeup", USERNAME_DOMAIN: "example.test" }, dir);
  ok("a login domain that is set is used", domain.status === 0 && config().usernameDomain === "example.test");
  ok("the file holds nothing but those three settings", Object.keys(config()).join() === "supabaseUrl,supabaseAnonKey,usernameDomain");

  rmSync(join(dir, "web/config.js"));
  const secret = await sh(script, { SUPABASE_URL: "https://abcdefgh.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_secret_madeup" }, dir);
  ok("a secret key in place of the publishable key stops the deploy and is never written to the site", secret.status === 1 && /holds a secret key/.test(secret.out) && !existsSync(join(dir, "web/config.js")), secret.out);
  const missing = await sh(script, { SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "" }, dir);
  ok("missing variables stop the deploy and say which to add", missing.status === 1 && /Add repository variables SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY/.test(missing.out) && !existsSync(join(dir, "web/config.js")), missing.out);
  rmSync(dir, { recursive: true, force: true });
}

// ---------- keepalive.yml: the daily call ----------
{
  const script = runBlock("keepalive.yml");
  const calls = [];
  let answer = { status: 200, body: '"2026-11-13T07:23:00+00:00"' };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { calls.push({ method: req.method, url: req.url, key: req.headers.apikey, body: raw }); res.writeHead(answer.status, { "content-type": "application/json" }); res.end(answer.body); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "snl-keepalive-"));

  const awake = await sh(script, { SUPABASE_URL: base + "/rest/v1/", SUPABASE_KEY: "sb_publishable_madeup" }, dir);
  ok("the daily call asks keepalive() with the publishable key and nothing else", awake.status === 0 && calls.length === 1 && calls[0].method === "POST" && calls[0].url === "/rest/v1/rpc/keepalive" && calls[0].key === "sb_publishable_madeup" && calls[0].body === "{}", calls);
  ok("a healthy answer reports the project is awake", /Supabase is awake/.test(awake.out), awake.out);
  answer = { status: 404, body: '{"message":"Could not find the function public.keepalive"}' };
  const absent = await sh(script, { SUPABASE_URL: base, SUPABASE_KEY: "sb_publishable_madeup" }, dir);
  ok("any other answer fails the run and says to run the keep-awake migration", absent.status === 1 && /keepalive\(\) answered 404/.test(absent.out) && /0002_keepalive\.sql/.test(absent.out), absent.out);
  const unset = await sh(script, { SUPABASE_URL: "", SUPABASE_KEY: "" }, dir);
  ok("missing variables fail the run and say which to add, without calling anything", unset.status === 1 && /Add repository variables/.test(unset.out) && calls.length === 2, unset.out);
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
