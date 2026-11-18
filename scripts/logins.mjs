#!/usr/bin/env node
// Manage SNL lookup logins. Runs on your own machine with the Supabase secret key.
// There is no self sign-up: this script is the only way a login is created.
//
//   node scripts/logins.mjs seed                                  create corpdev1, corpdev2
//   node scripts/logins.mjs add <username> <corpdev|reader> "<Display name>"
//                                                                 corpdev can also set up the statutory mapping; reader can only look
//   node scripts/logins.mjs reset <username>                      new random password
//   node scripts/logins.mjs remove <username>
//   node scripts/logins.mjs list
//
// Cloudflare sign-on (README, Cloudflare sign-on). People sign in through Cloudflare with their email address, and
// the first sign-in with an address lands on the Supabase user that has it:
//   node scripts/logins.mjs link <username> <email>               point an existing login at a real email address, so
//                                                                 its past answers, recent searches and saved things
//                                                                 stay with that person when they sign in through Cloudflare
//   node scripts/logins.mjs retire-passwords [--apply]            once everyone has moved: removes the logins still on
//                                                                 made-up addresses (username@USERNAME_DOMAIN), and gives
//                                                                 every other login a new password nobody is told.
//                                                                 Without --apply it only shows what it would do.
//
// Needs: SUPABASE_URL and SUPABASE_SECRET_KEY (the sb_secret_... key; the legacy SUPABASE_SERVICE_ROLE_KEY also works). Optional: USERNAME_DOMAIN (must match web/config.js).
// Passwords are printed once and never stored in plain text.

import { createClient } from "@supabase/supabase-js";
import { randomBytes, randomInt } from "node:crypto";

// Accept the URL as copied from anywhere in the dashboard: keep only https://<ref>.supabase.co
const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/(rest|auth)\/v1$/, "");
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const domain = process.env.USERNAME_DOMAIN || "snl-lookup.local";
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SECRET_KEY first (Supabase dashboard > Project settings > API Keys; the secret key starts with sb_secret_).");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const SEED = [
  { username: "corpdev1", role: "corpdev", name: "Corp Dev 1" },
  { username: "corpdev2", role: "corpdev", name: "Corp Dev 2" },
];

function password() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const pick = () => Array.from({ length: 6 }, () => a[randomInt(a.length)]).join("");
  return `${pick()}-${pick()}-${pick()}`;
}
const email = (u) => `${u}@${domain}`;
function checkUsername(u) {
  if (!/^[a-z0-9._-]{2,40}$/.test(u || "")) throw new Error(`"${u}" is not a valid username: use 2 to 40 lowercase letters, numbers, dots or dashes.`);
}
async function profileOf(username) {
  const { data, error } = await sb.from("profiles").select("id,username,display_name,role").eq("username", username).maybeSingle();
  if (error) throw error;
  return data;
}

async function add(username, role, name) {
  checkUsername(username);
  if (!["corpdev", "reader"].includes(role)) throw new Error('Role must be "corpdev" or "reader".');
  if (await profileOf(username)) return { username, role, name, password: null, note: "already exists (use reset)" };
  const pw = password();
  const { data, error } = await sb.auth.admin.createUser({
    email: email(username), password: pw, email_confirm: true, user_metadata: { username },
  });
  if (error) {
    if (/invalid/i.test(error.message)) throw new Error(`Supabase rejected ${email(username)}: ${error.message}. Set USERNAME_DOMAIN to your company's domain (and the same value in web/config.js), then retry.`);
    throw error;
  }
  const { error: pErr } = await sb.from("profiles").insert({ id: data.user.id, username, display_name: name || username, role });
  if (pErr) { await sb.auth.admin.deleteUser(data.user.id); throw pErr; }
  return { username, role, name: name || username, password: pw };
}

async function reset(username) {
  const p = await profileOf(username);
  if (!p) throw new Error(`No login called "${username}".`);
  const pw = password();
  const { error } = await sb.auth.admin.updateUserById(p.id, { password: pw });
  if (error) throw error;
  return { username, role: p.role, name: p.display_name, password: pw };
}

async function remove(username) {
  const p = await profileOf(username);
  if (!p) throw new Error(`No login called "${username}".`);
  const { error } = await sb.auth.admin.deleteUser(p.id); // the profile row is removed with it
  if (error) throw error;
  console.log(`Removed ${username}. They are signed out the next time their session refreshes (within an hour).`);
}

// ---------- Cloudflare sign-on ----------
const EMAIL = /^[^\s@",;<>]+@[^\s@",;<>]+\.[^\s@",;<>]+$/;

async function link(username, address) {
  checkUsername(username);
  const to = String(address || "").trim().toLowerCase();
  if (!EMAIL.test(to)) throw new Error(`"${address || ""}" is not an email address. Use the address the person signs in to Cloudflare with.`);
  if (to.endsWith("@" + domain)) throw new Error(`${to} is a made-up login address. Use the person's real email address.`);
  const p = await profileOf(username);
  if (!p) throw new Error(`No login called "${username}".`);
  const { data: got, error: gErr } = await sb.auth.admin.getUserById(p.id);
  if (gErr) throw gErr;
  if ((got?.user?.email || "").toLowerCase() === to) { console.log(`${username} is already linked to ${to}. Nothing changed.`); return; }
  const { error } = await sb.auth.admin.updateUserById(p.id, { email: to, email_confirm: true });
  if (error) {
    if (error.code === "email_exists" || /already (been )?registered|already exists/i.test(error.message || "")) throw new Error(`Another login already has ${to} (perhaps that person signed in through Cloudflare before this was run). Nothing changed. Remove that login first if it has nothing worth keeping (remove <its username>), then run this again.`);
    throw error;
  }
  console.log(`Linked ${username} to ${to}. When that person signs in through Cloudflare with this address, they keep this login's past answers, recent searches and saved things.`);
  console.log(`Until you run retire-passwords, this login can still sign in to the GitHub Pages copy, now with ${to} in the username box and the same password.`);
}

async function allUsers() {
  const out = [];
  for (let page = 1; page < 1000; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    out.push(...users);
    if (users.length < 200) break;
  }
  return out;
}

async function retirePasswords(apply) {
  const { data: profiles, error } = await sb.from("profiles").select("id,username,role");
  if (error) throw error;
  const byId = new Map((profiles || []).map((p) => [p.id, p]));
  const users = await allUsers();
  const madeUp = users.filter((u) => (u.email || "").toLowerCase().endsWith("@" + domain));
  const real = users.filter((u) => !madeUp.includes(u));
  console.log(madeUp.length ? `Logins still on made-up addresses (removed, with their past answers):` : "No logins are left on made-up addresses.");
  if (madeUp.length) console.table(madeUp.map((u) => ({ username: byId.get(u.id)?.username || "(no profile)", role: byId.get(u.id)?.role || "", email: u.email })));
  console.log(`${real.length} login${real.length === 1 ? "" : "s"} with a real email address keep everything; each gets a new password nobody is told, so only Cloudflare sign-in works for them.`);
  if (!apply) { console.log("\nNothing changed. Run again with --apply to do this."); return; }
  for (const u of madeUp) { const { error: e } = await sb.auth.admin.deleteUser(u.id); if (e) throw e; }
  for (const u of real) { const { error: e } = await sb.auth.admin.updateUserById(u.id, { password: randomBytes(48).toString("base64url") }); if (e) throw e; }
  console.log(`\nDone: removed ${madeUp.length}, new unknown password for ${real.length}.`);
  console.log("A browser already signed in with a password stays signed in until it signs out. To end every such session now, run this once in the Supabase SQL editor (people signed in through Cloudflare are signed in again by themselves):\n  delete from auth.sessions;");
}

function show(rows) {
  console.table(rows.map((r) => ({ username: r.username, role: r.role, name: r.name, password: r.password ?? r.note ?? "" })));
  if (rows.some((r) => r.password)) console.log("\nSend each password privately. They can change it after signing in (Change password).");
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "seed") {
    const out = [];
    for (const s of SEED) out.push(await add(s.username, s.role, s.name));
    show(out);
  } else if (cmd === "add") {
    show([await add(args[0], args[1], args[2])]);
  } else if (cmd === "reset") {
    show([await reset(args[0])]);
  } else if (cmd === "remove") {
    await remove(args[0]);
  } else if (cmd === "list") {
    const { data, error } = await sb.from("profiles").select("username,display_name,role,created_at").order("role").order("username");
    if (error) throw error;
    console.table(data.map((p) => ({ username: p.username, name: p.display_name, role: p.role, created: p.created_at.slice(0, 10) })));
  } else if (cmd === "link") {
    await link(args[0], args[1]);
  } else if (cmd === "retire-passwords") {
    await retirePasswords(args.includes("--apply"));
  } else {
    console.log("Usage: node scripts/logins.mjs seed | add <username> <corpdev|reader> \"<Name>\" | reset <username> | remove <username> | list | link <username> <email> | retire-passwords [--apply]");
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
