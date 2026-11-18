// Made-up answers from Claude for the filing summary suites (digest_*_test.ts). Every company, form and figure is made up.

/** A made-up summary from Claude in the shape asked for, every part supported by its quoted basis. */
export function goodRaw(over: Record<string, unknown> = {}) {
  return {
    summary: "Calloway Home Co files a new private client homeowners program and its forms in Florida.",
    programs: [{ name: "Signature Home", segment: "private client", basis: "The Signature Home program is offered to owners of homes valued over $1,000,000.", page: 4 }],
    forms: [
      { number: "CHO 30 01", edition: "06 25", title: "Homeowners policy", action: "new", replaces: null, basis: "CHO 30 01 06 25 Homeowners Policy New", page: 12 },
      { number: "CHO 31 07", edition: "06 25", title: "Water backup endorsement", action: "replaced", replaces: "HO 04 95", basis: "CHO 31 07 06 25 Water Backup Endorsement, replaces HO 04 95", page: 13 },
    ],
    rate: { overallPct: 9.8, requestedPct: 9.8, approvedPct: null, premium: 1200000, policyholders: 4210, effectiveNew: "2027-01-01", effectiveRenewal: null, basis: "Overall rate change 9.8%. Written premium affected $1.2 million. 4,210 policyholders. Effective 01/01/2027.", page: 3 },
    eligibility: [{ text: "Homes valued at $1,000,000 or more.", page: 20 }],
    notable: [{ text: "Uses a new wildfire score.", page: 31 }],
    ...over,
  };
}
