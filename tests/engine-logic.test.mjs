/* Engine logic tests — the sweep discipline, ported.
   Run: node tests/engine-logic.test.mjs   (exit 0 = all pass)
   Imports the engine as a module (the IS_MAIN guard keeps main() off)
   and drives evaluatePosting with fixture postings. No network: board
   postings carry their descriptions inline and the one workaround
   scenario stubs the board resolver. */
import { __test } from "../engine/hunt.mjs";

const { engine } = __test;
let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}
function rule(f, name) { return (f.check.rules || []).find((r) => r.rule === name) || {}; }

const RESUME = {
  detection: { skills: ["azure", "cloud architecture", "kubernetes"],
    employers: [], titles: ["Cloud Architect"], industries: [] },
  resume: { filename: "resume.pdf", text: "Cloud architect with 13 years on Azure. Cloud architecture, Kubernetes, Terraform, enterprise architecture strategy and roadmaps." },
};
function setup(ruleOverrides = {}, profileOverrides = {}) {
  engine.rules = Object.assign({ remote_only: true, minimum_pay: "", maximum_pay: "",
    posting_max_age_days: 7, block_hands_on: true, block_presales: false,
    focus_sectors: [], always_reject: [], extra_notes: "" }, ruleOverrides);
  engine.profile = Object.assign({ employers: { target: [], excluded: [] } }, RESUME, profileOverrides);
  engine.coverage = { saved: { titles: ["Cloud Architect"], lanes: [] } };
  engine.runs = { current_run: { evaluated_extra: 0 } };
  engine.filings = { filings: [] };
  engine.dedupe = new Set();
  engine.newFilings = [];
  engine.checkedThisRun = 0; engine.leadsThisRun = 0;
  engine.rejectedThisRun = 0; engine.notEvaluatedThisRun = 0;
  engine.boardResolver = null;
}
const GOOD_JD = "We are hiring a Cloud Architect to lead the design of enterprise cloud architecture on Azure. " +
  "You will develop architecture roadmaps and collaborate with engineering teams to deliver secure cloud solutions. " +
  "This is a fully remote position open to candidates anywhere in the United States. " +
  "The salary range is $175,000 - $195,000 per year. Requirements include experience with Azure and cloud architecture.";
const fresh = () => new Date().toISOString();
function posting(over = {}) {
  return Object.assign({ company: "Acme Health", title: "Senior Cloud Architect",
    location: "Remote, United States", url: "https://example.com/job/1",
    description: GOOD_JD, posted_at: fresh() }, over);
}

/* --- matcher regressions (from the title-faithfulness overhaul) --- */
ok(__test.titleMatches("Senior Healthcare Operations Director", ["Director of Healthcare Operations"]) != null, "matcher: level/word-order variants match");
ok(__test.titleMatches("IT Director", ["Director of Healthcare Operations"]) == null, "matcher: different core does not match");
ok(__test.locationBlocksUS("Toronto, Canada") === true, "location: Canada blocks US");
ok(__test.locationBlocksUS("Remote, United States") === false, "location: US remote does not block");
const pt = __test.parsePayTop("The range is $95/hr for this contract.");
ok(pt && pt.annual === 95 * 2080 && pt.raw === "$95/hr", "pay parser: hourly figure annualizes with raw evidence", JSON.stringify(pt));
ok(__test.postingAgeDays(null) === null && __test.postingAgeDays(Date.now()) === 0, "freshness: unknown date null, today 0");

/* --- 1. clean park with the full 13-rule check --- */
setup();
await __test.evaluatePosting(posting(), "Greenhouse", null);
let f = engine.newFilings[0];
ok(engine.newFilings.length === 1 && f.status === "parked", "clean posting parks");
ok(f.check.verdict === "ready" && f.check.rules.length === 13, "parked check carries all 13 rules", String(f.check.rules.length));
ok(f.check.rules.map((r) => r.rule).join("|") === __test.CANON_RULES.join("|"), "check rules are in the sweep's canonical order");
ok(rule(f, "pay band").status === "pass" && rule(f, "100% remote US").status === "pass" &&
   rule(f, "posting freshness").status === "pass" && rule(f, "full JD read").status === "pass",
   "clean posting passes JD/remote/pay/freshness with evidence");

/* --- 2. non-US location rejects --- */
setup();
await __test.evaluatePosting(posting({ location: "Berlin, Germany" }), "Greenhouse", null);
f = engine.newFilings[0];
ok(f.status === "rejected" && f.category === "not-remote" && rule(f, "100% remote US").status === "fail",
   "non-US location rejects as not-remote", f.category);

/* --- 3. required hybrid schedule rejects with a quoted duty --- */
setup();
await __test.evaluatePosting(posting({ description:
  "You will design enterprise cloud architecture on Azure and develop roadmaps with engineering teams. " +
  "This hybrid role requires 3 days per week in the office in Austin, Texas. " +
  "Requirements include experience with Azure and cloud architecture." }), "Greenhouse", null);
f = engine.newFilings[0];
ok(f.status === "rejected" && f.category === "not-remote" &&
   rule(f, "100% remote US").evidence.includes("hybrid role requires 3 days"),
   "required hybrid schedule rejects, quoting the posting", f.category);

/* --- 4. pay above the ceiling rejects --- */
setup({ maximum_pay: "$200,000" });
await __test.evaluatePosting(posting({ description: GOOD_JD.replace("$175,000 - $195,000", "$240,000 - $260,000") }), "Greenhouse", null);
f = engine.newFilings[0];
ok(f.status === "rejected" && f.category === "pay-outside-band" && rule(f, "pay band").status === "fail",
   "range topping above the ceiling rejects", f.category);

/* --- 5. unpublished pay stays eligible --- */
setup({ minimum_pay: "$160,000" });
await __test.evaluatePosting(posting({ description: GOOD_JD.replace(" The salary range is $175,000 - $195,000 per year.", "") }), "Greenhouse", null);
f = engine.newFilings[0];
ok(f.status === "parked" && rule(f, "pay band").status === "pass" &&
   rule(f, "pay band").evidence.includes("unpublished pay stays eligible"),
   "unpublished pay parks under a floor", f.status);

/* --- 6. stale posting rejects --- */
setup();
await __test.evaluatePosting(posting({ posted_at: new Date(Date.now() - 30 * 86400000).toISOString() }), "Greenhouse", null);
f = engine.newFilings[0];
ok(f.status === "rejected" && f.category === "stale-posting" && rule(f, "posting freshness").status === "fail",
   "30-day-old posting rejects as stale", f.category);

/* --- 7. whole-role hands-on duties reject --- */
setup();
await __test.evaluatePosting(posting({ description:
  "As a Cloud Architect you will design Azure cloud architecture for clients. " +
  "You will spend 70% of your time coding new platform features and writing code daily. " +
  "This is a fully remote position in the United States." }), "Greenhouse", null);
f = engine.newFilings[0];
ok(f.status === "rejected" && f.category === "hands-on-duties" && rule(f, "hands-on duties").status === "fail",
   "70%-coding role rejects as hands-on", f.category);

/* --- 8. pre-sales bar: on rejects, off is an honest grey --- */
setup({ block_presales: true });
await __test.evaluatePosting(posting({ description:
  "You will lead cloud architecture engagements for enterprise clients on Azure. " +
  "You will carry a sales quota for your territory and own pipeline generation. " +
  "This is a fully remote position in the United States." }), "Greenhouse", null);
f = engine.newFilings[0];
ok(f.status === "rejected" && f.category === "pre-sales" && rule(f, "pre-sales bar").status === "fail",
   "quota-carrying role rejects when the pre-sales bar is on", f.category);
setup({ block_presales: false });
await __test.evaluatePosting(posting({ description:
  "You will lead cloud architecture engagements for enterprise clients on Azure. " +
  "You will carry a sales quota for your territory and own pipeline generation. " +
  "This is a fully remote position in the United States." }), "Greenhouse", null);
f = engine.newFilings[0];
ok(f.status === "parked" && rule(f, "pre-sales bar").status === "grey",
   "same role parks when the pre-sales bar is off (grey, not hidden)", f.status);

/* --- 9. core experience mismatch rejects --- */
setup();
await __test.evaluatePosting(posting({ description:
  "We require deep experience with Epic and Cerner implementations and clinical patient care workflows. " +
  "You must have experience with Epic and Cerner in a hospital setting. " +
  "This is a fully remote position in the United States." }), "Greenhouse", null);
f = engine.newFilings[0];
ok(f.status === "rejected" && f.category === "experience-mismatch" && rule(f, "experience alignment").status === "fail",
   "JD demanding only absent skills rejects as experience mismatch", f.category);

/* --- 10. unreadable JD is NOT EVALUATED, never dispositioned --- */
setup();
await __test.evaluatePosting(posting({ description: "" }), "Greenhouse", null);
ok(engine.newFilings.length === 0 && engine.notEvaluatedThisRun === 1,
   "empty description → not evaluated, no disposition");

/* --- 11. excluded employer rejects on the gate fact --- */
setup({}, { employers: { target: [], excluded: ["BadCorp"] } });
await __test.evaluatePosting(posting({ company: "BadCorp", description: "" }), "Greenhouse", null);
f = engine.newFilings[0];
ok(f.status === "rejected" && f.category === "employer-excluded" &&
   rule(f, "employer exclusions").status === "fail" && rule(f, "full JD read").status === "grey",
   "excluded employer rejects on sight, JD honestly unread", f.category);

/* --- 12. employer+title dedupe: a repost under a new URL is one lead --- */
setup();
await __test.evaluatePosting(posting(), "Greenhouse", null);
await __test.evaluatePosting(posting({ url: "https://example.com/repost/99" }), "Lever", null);
ok(engine.newFilings.length === 1, "same employer + title under a new URL does not disposition twice",
   String(engine.newFilings.length));

/* --- 13. off-title postings are screened out silently --- */
setup();
await __test.evaluatePosting(posting({ title: "Marketing Manager" }), "Greenhouse", null);
ok(engine.newFilings.length === 0 && engine.checkedThisRun === 1,
   "off-title posting counts as checked, records nothing");

/* --- 14. workaround pass: the employer's own board governs a feed reject --- */
setup();
engine.boardResolver = async () => ({ source: "Greenhouse", slug: "acmehealth",
  postings: [posting({ url: "https://boards.example.com/1" })] });
await __test.evaluatePosting(posting({ description:
  "You will design enterprise cloud architecture on Azure and develop roadmaps with engineering teams. " +
  "This hybrid role requires 3 days per week in the office in Austin, Texas. " +
  "Requirements include experience with Azure and cloud architecture." }), "RemoteOK", null);
f = engine.newFilings[0];
ok(f.status === "parked" && f.where === "Greenhouse" &&
   f.check.rules.some((r) => r.rule === "workarounds tried" && r.status === "pass"),
   "feed reject is overturned by the employer's own board copy", f.status + "/" + f.where);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
