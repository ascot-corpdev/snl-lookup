// The one-click S&P connection check (snl-filings, action "check"): the steps a first live call needs, in order,
// stopping at the first failure, as a plain-English report the owner can act on or send to S&P.
//
// It costs at most five S&P requests: one sign-in and the four reference lists (one each), every one through the
// usual gate, so the hourly and daily limits and the 1-a-second spacing hold. Nothing is retried. The lists it
// loads are saved, so the Filings form uses them afterwards without asking S&P again.

import type { Db, Usage } from "./db.ts";
import { getReference, type Reference, type ReferenceField } from "./filings.ts";
import { DOC_TYPE, type Gate, type Plan, Spgmi, type SpgmiCreds, SpgmiError } from "./spgmi.ts";

export type CheckStepId = "signin" | "entitlement" | "states" | "lists";
export type CheckStep = { id: CheckStepId; ok: boolean; title: string; detail: string; requestId?: string };
export type CheckReport = {
  configured: boolean; checkedAt: string; account: Plan; limits: Usage; used: Usage;
  /** S&P requests this check sent. */
  requests: number;
  steps: CheckStep[];
  /** Whether Florida is in S&P's state list; null when the list wasn't loaded. */
  florida: boolean | null;
  summary: string;
};

export const CHECK_NOT_CONFIGURED = "S&P isn't set up yet, so there was nothing to check. When S&P sends the API username and password, set SPGMI_API_USERNAME and SPGMI_API_PASSWORD on Supabase (README, step 5), then click Check S&P connection again.";

const OTHER_LISTS: [ReferenceField, string][] = [["typeOfInsurance", "Types of insurance"], ["serffFilingType", "Filing types"], ["filingStatus", "Statuses"]];

/** True when S&P's state list has Florida, by code or by name, whichever column S&P puts it in. */
export function hasFlorida(ref: Reference): boolean {
  const isFl = (v: unknown) => typeof v === "string" && /^(fl|florida)$/i.test(v.trim());
  return ref.options.some((o) => isFl(o.id) || isFl(o.name)) || ref.rows.some((r) => Object.values(r).some(isFl));
}

export async function checkConnection(o: {
  creds: SpgmiCreds; db: Db; gate: Gate; fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number;
  plan: Plan; limits: Usage;
}): Promise<CheckReport> {
  const started = o.now();
  let requests = 0;
  const steps: CheckStep[] = [];
  let florida: boolean | null = null;
  const report = async (summary: string): Promise<CheckReport> => ({
    configured: Spgmi.configured(o.creds), checkedAt: new Date(started).toISOString(), account: o.plan,
    limits: { hour: o.limits.hour, day: o.limits.day }, used: await o.db.usage(), requests, steps, florida, summary,
  });
  if (!Spgmi.configured(o.creds)) return report(CHECK_NOT_CONFIGURED);

  // Count only the requests that really go to S&P: a gate that refuses (a limit) throws before the count.
  const gate: Gate = async () => { await o.gate(); requests++; };
  const api = new Spgmi(o.creds, { fetch: o.fetch, gate, sleep: o.sleep, now: o.now, once: true });
  const failed = (id: CheckStepId, title: string, e: unknown): CheckStep => {
    if (!(e instanceof SpgmiError)) throw e;
    if (e.code === "limit") title = "Stopped before asking S&P: a request limit is used up";
    return { id, ok: false, title, detail: e.message, ...(e.requestId ? { requestId: e.requestId } : {}) };
  };
  const stop = (step: CheckStep) => { steps.push(step); return report(`The S&P connection isn't working yet. ${step.title}. ${step.id === "entitlement" ? "Ask S&P for the entitlement named below." : "The step below says what to do."}`); };

  // 1. Sign in, in full, so the credentials themselves are tested.
  try { await api.signInNow(); }
  catch (e) { return stop(failed("signin", "Couldn't sign in to S&P", e)); }
  steps.push({ id: "signin", ok: true, title: "Signed in to S&P", detail: "S&P accepted the API username and password." });

  // 2 and 3. The state list is the first data call: a 403 there means the account isn't entitled to the product.
  let states: Reference | null;
  try { states = await getReference(api, o.db, "serffFilingState", { refresh: true, now: o.now() }); }
  catch (e) {
    if (e instanceof SpgmiError && e.code === "entitlement") {
      return stop({ id: "entitlement", ok: false, title: "This S&P account can't use SNL Insurance Product Filings yet",
        detail: `S&P signed the app in but refused filings data (403, entitlement needed). Ask S&P to add the ${DOC_TYPE} entitlement (SNL Insurance Product Filings, Physical Documents API) to this API account.`,
        ...(e.requestId ? { requestId: e.requestId } : {}) });
    }
    return stop(failed("states", "Couldn't load S&P's list of states", e));
  }
  steps.push({ id: "entitlement", ok: true, title: "Entitled to SNL Insurance Product Filings", detail: `S&P let the app read filings data (${DOC_TYPE}).` });
  const n = states?.options.length ?? 0;
  if (!states || !n) return stop({ id: "states", ok: false, title: "S&P's list of states came back empty", detail: "S&P returned nothing for the list of states. Ask S&P whether this API account can see SNL Insurance Product Filings." });
  florida = hasFlorida(states);
  steps.push({ id: "states", ok: true, title: "Loaded S&P's list of states",
    detail: `${n.toLocaleString("en-US")} ${n === 1 ? "state" : "states"}. ${florida ? "Florida (FL) is in the list." : "Florida (FL) isn't in the list: ask S&P whether this account covers Florida filings."}` });

  // 4. The other three lists the search form needs.
  const counts: string[] = [];
  for (const [field, label] of OTHER_LISTS) {
    let ref: Reference | null;
    try { ref = await getReference(api, o.db, field, { refresh: true, now: o.now() }); }
    catch (e) { return stop(failed("lists", `Couldn't load S&P's list of ${label.toLowerCase()}`, e)); }
    const c = ref?.options.length ?? 0;
    if (!c) return stop({ id: "lists", ok: false, title: `S&P's list of ${label.toLowerCase()} came back empty`, detail: `S&P returned nothing for the list of ${label.toLowerCase()}. ${counts.length ? `Loaded before it: ${counts.join(", ")}. ` : ""}Try again in a few minutes; if it repeats, ask S&P about it.` });
    counts.push(`${label.toLowerCase()} ${c.toLocaleString("en-US")}`);
  }
  steps.push({ id: "lists", ok: true, title: "Loaded the other three lists", detail: `${counts.join(", ").replace(/^./, (c) => c.toUpperCase())}.` });

  return report(florida
    ? "The S&P connection works. The app signed in, can read SNL Insurance Product Filings and loaded all four lists. Florida is in the state list, so you can run your first search."
    : "The S&P connection works, but Florida (FL) isn't in S&P's state list. Ask S&P whether this account covers Florida filings.");
}
