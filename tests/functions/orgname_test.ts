// Claude's instructions name the company only from the optional ORG_NAME secret: the answer prompt and the
// table prompt with and without a name, and runJob and buildTable passing the configured name to Anthropic.
import { orgName, SYSTEM, systemPrompt, tableSystem } from "../../supabase/functions/_shared/chat.ts";
import { forgetTokens } from "../../supabase/functions/_shared/spgmi.ts";
import { checks, env, fakeAnthropic, fakeClock, fakeSpgmi, memoryDb, req, say } from "./helpers/fakes.ts";
(globalThis as any).__SNL_TEST__ = true;
const chat = await import(new URL("../../supabase/functions/snl-chat/index.ts", import.meta.url).href);

const { ok, done } = checks();

// ----- the answer prompt -----
const named = systemPrompt("Calloway Group"), plain = systemPrompt("");
ok("with a name, Claude works for that company's team", named.startsWith("You answer questions for Calloway Group's Strategy and Corporate Development team from S&P Global Market Intelligence data."));
ok("without a name, Claude works for an insurer's team", plain.startsWith("You answer questions for an insurer's Strategy and Corporate Development team from S&P Global Market Intelligence data."));
ok("with a name, Claude has no access to that company's deals", named.includes("You have no access to Calloway Group's deals, pipeline or internal information"));
ok("without a name, Claude has no access to the team's deals", plain.includes("You have no access to the team's deals, pipeline or internal information"));
ok("the writing rules are called house style, with or without a name", named.includes("\nHouse style: plain English, sentence case, no em dashes.") && plain.includes("\nHouse style: plain English, sentence case, no em dashes."));
ok("SYSTEM is the prompt without a name", SYSTEM === plain && systemPrompt() === plain);
ok("the name changes nothing else in the prompt", named.replaceAll("Calloway Group's", "X").replace("an insurer's", "X") === plain.replace("an insurer's", "X").replace("the team's", "X"));

// ----- the table prompt -----
ok("the table prompt names the company's team when set", tableSystem("Calloway Group").startsWith("You turn a finished answer into one comparison table for Calloway Group's corporate development team."));
ok("the table prompt says an insurer's team when not", tableSystem().startsWith("You turn a finished answer into one comparison table for an insurer's corporate development team.") && tableSystem("") === tableSystem());

// ----- reading the secret -----
const orgEnv = (v?: string) => (k: string) => k === "ORG_NAME" ? v : undefined;
ok("ORG_NAME is read and trimmed", orgName(orgEnv("  Calloway Group ")) === "Calloway Group");
ok("an unset or blank ORG_NAME is no name", orgName(orgEnv()) === "" && orgName(orgEnv("   ")) === "");

// ----- runJob and buildTable use it: one question through snl-chat, with and without ORG_NAME -----
async function asked(secrets: Record<string, string>) {
  forgetTokens();
  const clock = fakeClock(), db = memoryDb(clock), sp = fakeSpgmi(clock, {});
  const claude = fakeAnthropic([{ content: [say("S&P's data has nothing on that.")] }, { content: [say(JSON.stringify({ needs_table: false, title: "", columns: [], rows: [], notes: [] }))] }]);
  const pending: Promise<unknown>[] = [];
  const deps = { env: env({ SPGMI_API_USERNAME: "api-user", SPGMI_API_PASSWORD: "api-pass", ANTHROPIC_API_KEY: "test-anthropic-key", ...secrets }), fetch: sp.fetch, anthropicFetch: claude.fetch,
    now: clock.fn, whoIs: async () => ({ id: "login-0a0a0a0a", role: "corpdev" }), db, sleep: clock.sleep, background: (p: Promise<unknown>) => { pending.push(p); } };
  const res: Response = await chat.handle(req("snl-chat", { action: "ask", question: "What did Calloway file?" }), deps);
  const { jobId } = await res.json();
  while (pending.length) await pending.shift();
  return { job: db.jobs.get(jobId)!, answer: claude.calls[0]?.body, table: claude.calls[1]?.body };
}
const withName = await asked({ ORG_NAME: " Calloway Group " }), without = await asked({});
ok("with ORG_NAME set, the answer and table requests carry the named prompts", withName.job.status === "done" && withName.answer.system[0].text === systemPrompt("Calloway Group") && withName.table.system === tableSystem("Calloway Group"), withName.job);
ok("without ORG_NAME, they carry the neutral prompts", without.job.status === "done" && without.answer.system[0].text === SYSTEM && without.table.system === tableSystem(""), without.job);

done();
