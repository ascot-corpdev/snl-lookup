// The optional company look-up in the statutory mapping: NAIC codes for companies the company list has with an S&P
// institution id but no NAIC company code, looked up on Snowflake in one statement, filled into the answer and saved
// to the company list only where it has no code. The mapping's checks, the SQL text and its bindings, codes found
// and saved, a code the owner loaded never overwritten, two codes for one institution id, nothing found, a failure
// and a time-out. Every view, column, company, id and code here is made up.
(globalThis as any).__SNL_TEST__ = true;
const statutory = await import(new URL("../../supabase/functions/snl-statutory/index.ts", import.meta.url).href);
import { buildCompanySql, COMPANIES_NOT_MAPPED, companiesMapped, companiesProblem, MAX_CODE_IDS, readCodeRows, readMapping } from "../../supabase/functions/_shared/statutory.ts";
import { type Entity, filledRow } from "../../supabase/functions/_shared/db.ts";
import { resolveEntity } from "../../supabase/functions/_shared/filings.ts";
import { checks, corpdev, env, fakeClock, memoryDb, reader, req } from "./helpers/fakes.ts";
import { fakeSnowflake, type SfReply } from "./helpers/snowflake.ts";

const { ok, done } = checks();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const PAT = { SNOWFLAKE_ACCOUNT: "ab12345", SNOWFLAKE_USER: "svc_snl", SNOWFLAKE_WAREHOUSE: "WH_TEST", SNOWFLAKE_PAT: "test-pat-not-a-secret" };
const SNL = "Calloway Group (SNL P&C Group)";
const E = (over: Partial<Entity>): Entity => ({ companyId: null, companyName: "Calloway Insurance Co", naicCompanyCode: null, institutionId: null, spStatEntityId: null, naicGroupCode: null, naicGroupName: null, ...over });

// The company look-up, in the mapping language, with placeholder names (not S&P's).
const LOOKUP = {
  view: "ENTITY.ENTITY_LIST", as: "E",
  joins: [{ view: "ENTITY.NAIC_GROUP", as: "G", kind: "left", on: [{ left: "E.INST_ID", right: "G.INST_ID" }] }],
  where: [{ column: "E.ENTITY_TYPE", equals: "Institution" }],
  institution: "E.INST_ID", company: "E.NAIC_CD", name: "E.ENTITY_NAME", groupCode: "G.GRP_CD", groupName: "G.GRP_NAME", latest: "G.MOST_RECENT",
};
const FIELDS = { surplus: { view: "IR_SURPLUS", entity: { company: "NAIC_CD" }, year: "STMT_YEAR", value: "PHS_000" } };
const SQL = 'SELECT DISTINCT "E".INST_ID AS INST, "E".NAIC_CD AS CODE, "E".ENTITY_NAME AS NAME, "G".GRP_CD AS GROUP_CODE, "G".GRP_NAME AS GROUP_NAME FROM MI_XPRESSCLOUD.ENTITY.ENTITY_LIST AS "E" LEFT JOIN MI_XPRESSCLOUD.ENTITY.NAIC_GROUP AS "G" ON "E".INST_ID = "G".INST_ID WHERE "E".INST_ID IN (?, ?, ?, ?) AND "E".ENTITY_TYPE = ? QUALIFY ROW_NUMBER() OVER (PARTITION BY "E".INST_ID, "E".NAIC_CD ORDER BY "G".MOST_RECENT DESC NULLS LAST) = 1 ORDER BY 1, 2 LIMIT 500';

// S&P's views, made up: entity rows (institutions and a group row to leave out) and NAIC group membership by sequence.
const ENTITY = [
  { INST_ID: "5000001", NAIC_CD: "90001", ENTITY_NAME: "Calloway Insurance Co", ENTITY_TYPE: "Institution" },
  { INST_ID: "5000001", NAIC_CD: null, ENTITY_NAME: "Calloway Group", ENTITY_TYPE: "Group" },
  { INST_ID: "5000002", NAIC_CD: "90002", ENTITY_NAME: "Calloway Home Co", ENTITY_TYPE: "Institution" },
  { INST_ID: "5000003", NAIC_CD: null, ENTITY_NAME: "Tarrow Mutual Insurance Co", ENTITY_TYPE: "Institution" },
  { INST_ID: "5000004", NAIC_CD: "90041", ENTITY_NAME: "Nonesuch Twin Co", ENTITY_TYPE: "Institution" },
  { INST_ID: "5000004", NAIC_CD: "90042", ENTITY_NAME: "Nonesuch Twin Co", ENTITY_TYPE: "Institution" },
  { INST_ID: "5000005", NAIC_CD: "90777", ENTITY_NAME: "Calloway Coastal Co", ENTITY_TYPE: "Institution" },
  { INST_ID: "5000006", NAIC_CD: "90006", ENTITY_NAME: "<img src=x onerror=alert(1)> Co", ENTITY_TYPE: "Institution" },
];
const GROUPS = [
  { INST_ID: "5000001", GRP_CD: "8001", GRP_NAME: "Old Calloway Grp", MOST_RECENT: "0" },
  { INST_ID: "5000001", GRP_CD: "9001", GRP_NAME: "Calloway Grp", MOST_RECENT: "1" },
  { INST_ID: "5000002", GRP_CD: "9001", GRP_NAME: "Calloway Grp", MOST_RECENT: "1" },
  { INST_ID: "5000006", GRP_CD: "9006", GRP_NAME: "<b>Nonesuch</b> Grp", MOST_RECENT: "1" },
];
/** Answers exactly the statement above (any number of ids), from the made-up views, using the BOUND values. */
function answer(statement: string, bindings: { type: string; value: string }[]): SfReply | undefined {
  if (!statement.startsWith("SELECT DISTINCT")) return undefined;
  const n = (statement.match(/IN \(([?, ]+)\)/)![1].match(/\?/g) ?? []).length;
  if (statement !== SQL.replace("IN (?, ?, ?, ?)", `IN (${Array(n).fill("?").join(", ")})`)) return { error: { status: 422, message: "SQL compilation error: unexpected statement." } };
  const ids = bindings.slice(0, n).map((b) => b.value), type = bindings[n].value;
  const rows: (string | null)[][] = [];
  for (const e of ENTITY.filter((e) => ids.includes(e.INST_ID) && e.ENTITY_TYPE === type)) {
    const gs = GROUPS.filter((g) => g.INST_ID === e.INST_ID).sort((a, b) => Number(b.MOST_RECENT) - Number(a.MOST_RECENT));
    const g = gs[0] ?? null;   // QUALIFY ... MOST_RECENT DESC NULLS LAST = 1
    rows.push([e.INST_ID, e.NAIC_CD, e.ENTITY_NAME, g ? g.GRP_CD : null, g ? g.GRP_NAME : null]);
  }
  return { columns: ["INST", "CODE", "NAME", "GROUP_CODE", "GROUP_NAME"], rows };
}

function world(o: { mapping?: unknown; secrets?: Record<string, string>; on?: typeof answer } = {}) {
  const clock = fakeClock("2026-11-22T12:00:00Z"), db = memoryDb(clock), sf = fakeSnowflake(clock, { on: o.on ?? answer });
  db.settings.set("statutory_mapping", (o.mapping === undefined ? { fields: FIELDS, companies: LOOKUP } : o.mapping) as Record<string, unknown>);
  const put = (id: string, doc: Entity) => db.store.set(id, { id, kind: "entity", label: [doc.companyName, doc.naicCompanyCode ? `NAIC ${doc.naicCompanyCode}` : "", doc.naicGroupName ?? ""].filter(Boolean).join(" | "), doc: doc as unknown as Record<string, unknown>, fetched_at: "2026-11-01T00:00:00.000Z" });
  // The company list as the owner's live one is: institution ids and S&P's group name, no NAIC code.
  put("entity:i.5000001", E({ institutionId: "5000001", naicGroupName: SNL }));
  put("entity:i.5000002", E({ companyName: "Calloway Home Co", institutionId: "5000002" }));
  put("entity:i.5000003", E({ companyName: "Tarrow Mutual Insurance Co", institutionId: "5000003", naicGroupName: "Tarrow Group (SNL P&C Group)" }));
  put("entity:i.5000004", E({ companyName: "Nonesuch Twin Co", institutionId: "5000004" }));
  put("entity:4000005", E({ companyName: "Calloway Coastal Co", companyId: "4000005", institutionId: "5000005", naicCompanyCode: "90005", naicGroupCode: "9001" }));   // the owner loaded this code
  put("entity:i.5000006", E({ companyName: "<img src=x onerror=alert(1)> Co", institutionId: "5000006" }));
  const deps = { env: env(o.secrets ?? PAT), fetch: sf.fetch, now: clock.fn, whoIs: reader, db, sleep: clock.sleep };
  const call = async (body: unknown, over: Record<string, unknown> = {}) => { const res: Response = await statutory.handle(req("snl-statutory", body), { ...deps, ...over }); return { status: res.status, body: await res.json() }; };
  return { clock, db, sf, call };
}
const IDS = ["5000001", "5000002", "5000003", "5000004", "5000005", "5000099"];

// ---------- the mapping's checks ----------
{
  ok("a good company look-up passes the checks", companiesProblem(LOOKUP) === null && companiesMapped(readMapping({ fields: {}, companies: LOOKUP })));
  ok("without one, nothing is wrong and nothing is mapped", companiesProblem(undefined) === null && !companiesMapped(readMapping({ fields: FIELDS })));
  ok("the smallest look-up: one view, three columns", companiesProblem({ view: "ENTITY_LIST", institution: "INST_ID", company: "NAIC_CD", name: "ENTITY_NAME" }) === null);
  ok("readMapping keeps the look-up beside fields and loaded, and leaves it out when there is none", same(readMapping({ fields: {}, loaded: { view: "B", at: "D" }, companies: LOOKUP }), { fields: {}, loaded: { view: "B", at: "D" }, companies: LOOKUP }) && same(readMapping({ fields: {} }), { fields: {} }));
  const bad: [string, unknown, string][] = [
    ["not an object", "ENTITY_LIST", "companies must be {view, institution, company, name}, with joins, where, groupCode, groupName and latest when needed"],
    ["a part it doesn't take", { ...LOOKUP, scale: 1000 }, "companies.scale isn't part of the company look-up. It takes view, as, joins, where, institution, company, name, groupCode, groupName, latest"],
    ["no institution column", { ...LOOKUP, institution: undefined }, "companies.institution must be a column name"],
    ["no NAIC code column", { view: "V", institution: "I", name: "N" }, "companies.company must be a column name"],
    ["no name column", { view: "V", institution: "I", company: "C" }, "companies.name must be a column name"],
    ["a hostile view name", { ...LOOKUP, view: "ENTITY.X; DROP TABLE Y" }, "companies.view must be a view name"],
    ["a hostile column", { ...LOOKUP, company: 'E.NAIC"--' }, "companies.company must be a column name"],
    ["a hostile group name column", { ...LOOKUP, groupName: "G.NAME OR 1=1" }, "companies.groupName must be a column name"],
    ["a column without its view's short name when there are joins", { ...LOOKUP, name: "ENTITY_NAME" }, "companies.name must be ALIAS.COLUMN when there are joins"],
    ["a view's short name that isn't declared", { ...LOOKUP, groupCode: "X.GRP_CD" }, "companies.groupCode names alias X, which isn't declared"],
    ["a join to nothing before it", { ...LOOKUP, joins: [{ view: "ENTITY.NAIC_GROUP", as: "G", on: [{ left: "Q.INST_ID", right: "G.INST_ID" }] }] }, "companies.joins[0].on[0].left names alias Q, which isn't declared"],
    ["a condition for one kind of lookup", { ...LOOKUP, where: [{ column: "E.ENTITY_TYPE", equals: "Institution", when: "group" }] }, "companies.where[0].when isn't used in the company look-up: leave it out"],
    ["a condition with two tests", { ...LOOKUP, where: [{ column: "E.ENTITY_TYPE", equals: "Institution", isNull: true }] }, "companies.where[0] needs exactly one of equals, notEquals, in, isNull, month or startsWith"],
    ["latest as an object", { ...LOOKUP, latest: [{ column: "G.MOST_RECENT" }] }, "companies.latest must be a column, or a list of 1 to 3 columns"],
    ["latest with four columns", { ...LOOKUP, latest: ["G.A", "G.B", "G.C", "G.D"] }, "companies.latest must be a column, or a list of 1 to 3 columns"],
  ];
  for (const [what, m, want] of bad) ok(`checked: ${what}`, companiesProblem(m) === want, companiesProblem(m));
}

// ---------- the SQL ----------
{
  const sql = buildCompanySql("MI_XPRESSCLOUD", "XPRESSFEED", LOOKUP as never, ["5000001", "5000002", "5000003", "5000004"]);
  ok("one read-only statement, every name from the checked mapping", sql?.statement === SQL, sql?.statement);
  ok("the ids and the condition's text are bound, never written in", same(sql?.bindings, [...["5000001", "5000002", "5000003", "5000004"].map((value) => ({ type: "TEXT", value })), { type: "TEXT", value: "Institution" }]) && !/5000001|Institution/.test(sql!.statement));
  const plain = buildCompanySql("MI_XPRESSCLOUD", "XPRESSFEED", { view: "ENTITY_LIST", institution: "INST_ID", company: "NAIC_CD", name: "ENTITY_NAME" }, ["5000001"]);
  ok("the smallest look-up: the default schema, no group, no latest", plain?.statement === "SELECT DISTINCT INST_ID AS INST, NAIC_CD AS CODE, ENTITY_NAME AS NAME, NULL AS GROUP_CODE, NULL AS GROUP_NAME FROM MI_XPRESSCLOUD.XPRESSFEED.ENTITY_LIST WHERE INST_ID IN (?) ORDER BY 1, 2 LIMIT 500", plain?.statement);
  ok("bounded: no statement for no ids, more than 50, an id that isn't a whole number, or a bad database name",
    buildCompanySql("MI_XPRESSCLOUD", "XPRESSFEED", LOOKUP as never, []) === null && buildCompanySql("MI_XPRESSCLOUD", "XPRESSFEED", LOOKUP as never, Array.from({ length: MAX_CODE_IDS + 1 }, (_, i) => String(5000100 + i))) === null
    && buildCompanySql("MI_XPRESSCLOUD", "XPRESSFEED", LOOKUP as never, ["5000001) OR (1=1"]) === null && buildCompanySql("X;Y", "XPRESSFEED", LOOKUP as never, ["5000001"]) === null && MAX_CODE_IDS === 50);
  const read = readCodeRows([{ INST: "5000001", CODE: "90001", GROUP_CODE: "9001", GROUP_NAME: "Calloway Grp" }, { INST: "5000001", CODE: "90001", GROUP_CODE: "8001", GROUP_NAME: "Old" }, { INST: 5000002, CODE: 90002, GROUP_CODE: null, GROUP_NAME: null }, { INST: "5000004", CODE: "90042" }, { INST: "5000004", CODE: "90041" }, { INST: "5000003", CODE: "9O003" }], ["5000001", "5000002", "5000003", "5000004"]);
  ok("one code with two groups: the code is kept and the group left empty, as neither is sure", same(read.get("5000001"), { institutionId: "5000001", status: "found", naicCompanyCode: "90001", naicGroupCode: null, naicGroupName: null }));
  ok("numbers from Snowflake read as codes", read.get("5000002")?.naicCompanyCode === "90002" && read.get("5000002")?.status === "found");
  ok("two codes for one institution id: neither is chosen, both are listed", read.get("5000004")?.status === "several" && same(read.get("5000004")?.codes, ["90041", "90042"]) && read.get("5000004")?.naicCompanyCode === null);
  ok("a code that isn't a NAIC code counts as none", read.get("5000003")?.status === "none");
}

// ---------- codes found, filled and saved ----------
{
  const w = world();
  const r = await w.call({ action: "codes", institutionIds: IDS });
  const by = Object.fromEntries(r.body.results.map((x: any) => [x.institutionId, x]));
  ok("one statement, only for the ids the list has with no code, in order", r.status === 200 && w.sf.statements.length === 1 && same(w.sf.statements[0].bindings.map((b) => b.value), ["5000001", "5000002", "5000003", "5000004", "Institution"]) && r.body.asked === 4, { r, st: w.sf.statements });
  ok("found: the code, with the latest NAIC group", same(by["5000001"], { institutionId: "5000001", status: "found", naicCompanyCode: "90001", naicGroupCode: "9001", naicGroupName: "Calloway Grp" }), by["5000001"]);
  ok("none: S&P's statutory data has no code for it", by["5000003"].status === "none" && by["5000003"].naicCompanyCode === null);
  ok("several: two codes for one id, none chosen", by["5000004"].status === "several" && same(by["5000004"].codes, ["90041", "90042"]));
  ok("known: a code already in the list is given back and not asked for, even though Snowflake has another", by["5000005"].status === "known" && by["5000005"].naicCompanyCode === "90005");
  ok("unknown: an id that isn't in the company list isn't looked up", by["5000099"].status === "unknown");
  ok("the two codes found are saved to the company list", r.body.saved === 2);
  const row1 = w.db.store.get("entity:i.5000001")!, row2 = w.db.store.get("entity:i.5000002")!;
  ok("saved where empty: the code and group code, the group name the list already had kept", same(row1.doc, E({ naicCompanyCode: "90001", institutionId: "5000001", naicGroupCode: "9001", naicGroupName: SNL })) && row1.label === `Calloway Insurance Co | NAIC 90001 | ${SNL}`, row1);
  ok("a row with no group name gets the NAIC group's name", same(row2.doc, E({ companyName: "Calloway Home Co", naicCompanyCode: "90002", institutionId: "5000002", naicGroupCode: "9001", naicGroupName: "Calloway Grp" })), row2.doc);
  ok("the code the owner loaded is never overwritten", w.db.store.get("entity:4000005")!.doc.naicCompanyCode === "90005");
  ok("nothing is saved for none or several", w.db.store.get("entity:i.5000003")!.doc.naicCompanyCode === null && w.db.store.get("entity:i.5000004")!.doc.naicCompanyCode === null);
  const found = await resolveEntity(w.db, "Calloway");
  ok("the next Find by name has the codes without asking Snowflake", found.matches.filter((m) => m.naicCompanyCode).length === 3 && w.sf.statements.length === 1, found.matches);
  const again = await w.call({ action: "codes", institutionIds: IDS });
  const by2 = Object.fromEntries(again.body.results.map((x: any) => [x.institutionId, x.status]));
  ok("asking again sends no statement: found codes are known, none and several are remembered", again.status === 200 && w.sf.statements.length === 1 && again.body.asked === 0 && same(by2, { "5000001": "known", "5000002": "known", "5000003": "none", "5000004": "several", "5000005": "known", "5000099": "unknown" }), again.body);
  ok("several keeps its codes when remembered", same(again.body.results.find((x: any) => x.institutionId === "5000004").codes, ["90041", "90042"]));
  w.clock.now += 31 * 86_400_000;
  const later = await w.call({ action: "codes", institutionIds: ["5000003"] });
  ok("a month later, none is asked again", later.status === 200 && later.body.asked === 1 && w.sf.statements.length === 2);
  w.db.settings.set("statutory_mapping", { fields: FIELDS, companies: { ...LOOKUP, latest: ["G.MOST_RECENT"] } });
  const remapped = await w.call({ action: "codes", institutionIds: ["5000004"] });
  ok("a changed look-up asks again for an id remembered as several", remapped.status === 200 && remapped.body.asked === 1 && w.sf.statements.length === 3, remapped);
  const hostile = await world().call({ action: "codes", institutionIds: ["5000006"] });
  ok("a hostile name from Snowflake is kept as plain text", hostile.body.results[0].naicGroupName === "<b>Nonesuch</b> Grp" && hostile.body.results[0].naicCompanyCode === "90006");
}

// ---------- filling never overwrites ----------
{
  ok("filledRow: never where a code is already there", filledRow(E({ institutionId: "5000005", naicCompanyCode: "90005" }), { institutionId: "5000005", naicCompanyCode: "90777", naicGroupCode: null, naicGroupName: null }) === null);
  ok("filledRow: never into another institution's row", filledRow(E({ institutionId: "5000001" }), { institutionId: "5000002", naicCompanyCode: "90002", naicGroupCode: null, naicGroupName: null }) === null);
  ok("filledRow: a group code the row has is kept", filledRow(E({ institutionId: "5000001", naicGroupCode: "7001" }), { institutionId: "5000001", naicCompanyCode: "90001", naicGroupCode: "9001", naicGroupName: "X" })?.naicGroupCode === "7001");
  const w = world();
  ok("fillEntityCodes changes nothing for a loaded code", await w.db.fillEntityCodes!([{ institutionId: "5000005", naicCompanyCode: "90777", naicGroupCode: null, naicGroupName: null }]) === 0 && w.db.store.get("entity:4000005")!.doc.naicCompanyCode === "90005");
}

// ---------- nothing found, failures and time-outs ----------
{
  const empty = world({ on: (s) => (s.startsWith("SELECT DISTINCT") ? { columns: ["INST", "CODE", "NAME", "GROUP_CODE", "GROUP_NAME"], rows: [] } : undefined) });
  const r = await empty.call({ action: "codes", institutionIds: ["5000001", "5000002"] });
  ok("Snowflake returning nothing: each is none, nothing saved", r.status === 200 && r.body.results.every((x: any) => x.status === "none") && r.body.saved === 0 && empty.db.store.get("entity:i.5000001")!.doc.naicCompanyCode === null, r.body);

  const slow = world();
  slow.sf.failNext.push({ status: 408 });
  const t = await slow.call({ action: "codes", institutionIds: ["5000001"] });
  ok("a time-out answers with the plain reason, and nothing is saved or remembered", t.status === 502 && t.body.error === "snowflake_timeout" && /ran out of time/.test(t.body.message) && slow.db.store.get("entity:i.5000001")!.doc.naicCompanyCode === null && ![...slow.db.store.keys()].some((k) => k.startsWith("discover:nocode.")), t.body);
  const after = await slow.call({ action: "codes", institutionIds: ["5000001"] });
  ok("after a time-out the next try asks again", after.status === 200 && after.body.results[0].status === "found");

  const broken = world({ on: (s) => (s.startsWith("SELECT DISTINCT") ? { error: { status: 422, message: "SQL compilation error: invalid identifier 'E.NAIC_CD'" } } : undefined) });
  const b = await broken.call({ action: "codes", institutionIds: ["5000001"] });
  ok("a statement Snowflake can't run answers 502 with its reason", b.status === 502 && b.body.error === "snowflake_sql" && /couldn't run the query/.test(b.body.message), b.body);

  const off = world({ secrets: {} });
  const o = await off.call({ action: "codes", institutionIds: ["5000001"] });
  ok("Snowflake not set up: 503 not_configured", o.status === 503 && o.body.error === "not_configured");
  const k = await off.call({ action: "codes", institutionIds: ["5000005"] });
  ok("but codes already in the list need no Snowflake", k.status === 200 && k.body.results[0].status === "known");
}

// ---------- without the look-up, and bad requests ----------
{
  const w = world({ mapping: { fields: FIELDS } });
  const s = await w.call({ action: "status" });
  ok("status: without a look-up, it says not mapped and nothing is wrong", s.status === 200 && same(s.body.companies, { mapped: false, problem: null }) && s.body.mapped === true, s.body.companies);
  const c = await w.call({ action: "codes", institutionIds: ["5000001"] });
  ok("the codes action then answers 409 not_mapped, and nothing reaches Snowflake", c.status === 409 && c.body.error === "not_mapped" && c.body.message === COMPANIES_NOT_MAPPED && w.sf.log.length === 0, c.body);
  const badMap = world({ mapping: { fields: FIELDS, companies: { ...LOOKUP, view: "X;Y" } } });
  const s2 = await badMap.call({ action: "status" });
  ok("status shows what is wrong with a saved look-up", same(s2.body.companies, { mapped: false, problem: "companies.view must be a view name" }), s2.body.companies);
  ok("and a bad look-up sends nothing", (await badMap.call({ action: "codes", institutionIds: ["5000001"] })).status === 409 && badMap.sf.log.length === 0);
  const ok1 = await world().call({ action: "status" });
  ok("status with a good look-up", same(ok1.body.companies, { mapped: true, problem: null }));
  for (const [what, ids] of [["no ids", []], ["not a list", "5000001"], ["an id with letters", ["5000001x"]], ["an injection", ["1) OR (1=1"]], ["51 ids", Array.from({ length: 51 }, (_, i) => String(5000100 + i))]] as const) {
    const x = world(), r = await x.call({ action: "codes", institutionIds: ids });
    ok(`refused: ${what}`, r.status === 400 && r.body.message === "Give 1 to 50 S&P institution ids (whole numbers)." && x.sf.log.length === 0, r.body);
  }
  const dup = world(), d = await dup.call({ action: "codes", institutionIds: ["5000001", "5000001", 5000001] });
  ok("the same id twice is asked once", d.status === 200 && d.body.results.length === 1 && same(dup.sf.statements[0].bindings.map((b) => b.value), ["5000001", "Institution"]));
  const cd = await world().call({ action: "codes", institutionIds: ["5000001"] }, { whoIs: corpdev });
  ok("any signed-in login may look codes up (reader above, Corp Dev here)", cd.status === 200);
}

// ---------- the Profile view learns from its own status whether to look codes up ----------
{
  const profile = await import(new URL("../../supabase/functions/snl-profile/index.ts", import.meta.url).href);
  for (const [what, mapping, want] of [["with the look-up", { fields: FIELDS, companies: LOOKUP }, true], ["without it", { fields: FIELDS }, undefined], ["with a broken one", { fields: FIELDS, companies: { ...LOOKUP, name: undefined } }, undefined]] as const) {
    const clock = fakeClock(), db = memoryDb(clock);
    db.settings.set("statutory_mapping", mapping as unknown as Record<string, unknown>);
    const res: Response = await profile.handle(req("snl-profile", { action: "status" }), { env: env(PAT), fetch: (() => { throw new Error("no"); }) as unknown as typeof fetch, now: clock.fn, whoIs: reader, db, sleep: clock.sleep });
    const body = await res.json();
    ok(`profile status ${what}: codes is ${want ?? "left out"}`, res.status === 200 && body.statutory.codes === want && ("codes" in body.statutory) === (want === true), body.statutory);
  }
}

done();
