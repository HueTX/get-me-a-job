# Get Me A JOB — hunt engine: contract & page-integration notes

The hunt engine makes a run actually move. It runs **inside the user's own data
repo** on GitHub Actions, reads `data/*.json` from the checkout, does real job
discovery, and git-commits progress back to `data/` so the web page (polling the
repo) shows lanes and stages advancing. Files in this folder:

| File | Role |
|---|---|
| `hunt.mjs` | The engine. Node 20, zero dependencies (global `fetch` + `git` CLI). |
| `hunt.yml` | GitHub Actions workflow template. |
| `ENGINE_NOTES.md` | This contract. |

## What the page must install into a user's data repo

On connect (and once, for repos connected before the engine existed), the page
writes two files into the user's data repo, verbatim:

- `engine/hunt.yml` (this folder's template) → **`.github/workflows/hunt.yml`**
- `engine/hunt.mjs` → **`engine/hunt.mjs`**

Notes:

- The workflow file must be on the repo's **default branch** (`main`) before
  the first dispatch — GitHub only accepts `workflow_dispatch` for workflows
  that exist on the default branch.
- Actions must be enabled on the repo (default for new repos).
- Inside Actions, pushes back to `data/` use the workflow's own
  `GITHUB_TOKEN` (`permissions: contents: write` in `hunt.yml`) — **not** the
  user's token. The user's token is only needed by the page, for installing the
  two files and for dispatching.

## Starting a run from the page

```
POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/hunt.yml/dispatches
Authorization: Bearer <user token>
Accept: application/vnd.github+json
Body: { "ref": "main" }
```

Success is `204 No Content`. The engine then picks up (or creates) the run in
`data/runs.json` and starts committing progress within the first minute.

**Token permissions the user must grant** (fine-grained PAT, scoped to their
data repo only):

- **Contents: read and write** — data files + the two engine files.
- **Actions: read and write** — the dispatch call above.
- **Workflows: read and write** — required to create/update
  `.github/workflows/hunt.yml` through the Contents API; without it the install
  write is rejected with a 403.

**Stopping a run:** the page's existing Stop already works — write
`runs.state = "stopped"` (the page's `stopRun` also moves `current_run` to
`history`; the engine dedupes history by run id, so the double-move is safe).
The engine re-reads `runs.json` before every lane, after every employer, and
before the feeds pass, and latches the stop even if one of its own progress
writes briefly restores `"running"`. On stop it finalizes the run into
`history` with unfinished stages marked `stopped`, appends an activity entry,
commits `hunt: run stopped`, and exits 0.

Page wiring decision (either works — engine adopts or creates the run):
letting the page's Start keep writing `state:"running"` + `current_run` and
*then* dispatching is fine; dispatch-only is cleaner. Pick one and be
consistent.

## Data contract

### Engine reads (never writes): `profile.json`, `coverage.json`, `rules.json`

- `coverage.saved.titles` / `coverage.saved.lanes` — the only coverage the
  engine uses (drafts are ignored, matching "runs work from your saved
  coverage only").
- `profile.employers.excluded` — recorded as a rejected disposition
  (gate fact; see Evaluation below).
- `rules.remote_only`, `rules.minimum_pay`, `rules.maximum_pay`,
  `rules.posting_max_age_days`, `rules.block_hands_on`,
  `rules.block_presales`, `rules.always_reject`. Missing fields fall back
  to the sweep defaults: no ceiling, 7-day window, hands-on bar on,
  pre-sales bar off.
- **`connections.json` is never read.** `codes.json` and `answers.json` are
  never touched. No secrets are read, printed, or needed.

### Engine owns inside `runs.json`

- `state` (`running` while working, `idle` at finish, `stopped` preserved).
- `current_run.stages` — `[{ name, state, detail }]` for Preparing /
  Discovering / Evaluating / Filing / Closeout; `state` ∈
  `done | active | queued | stopped`; `detail` is a human sentence.
- `current_run.engine_updated_at` — refreshed on every progress write.
- Per-lane progress **on the `current_run.lanes[]` entries** (matched by
  `name`): `done`, `total`, `status` (`queued | searching | done | manual`),
  `detail`.
  - Sector lanes: `total` = employers actually checked (placeholder lines such
    as "Employer career pages…" are skipped and not counted); `done` =
    employers processed; end-of-lane `detail` summarizes every employer, e.g.
    `Stripe: Greenhouse board found — 200 postings checked · Acme LLC: no public board found`.
  - Board lanes: `done: 0, total: 1, status: "manual"` with the detail below.
- `current_run.evaluated_extra` — incremented for **every** posting examined
  (board + feed), matching title or not.
- `history` — the finished run (with `ended_at` and final stages) is unshifted
  at closeout.
- `lane_controls` / `requests` are **preserved**: every engine write merges
  into a fresh read of `runs.json` instead of overwriting the file wholesale.

### Engine writes into `filings.json`

New entries only, appended; deduped by **employer + title identity**
(normalized — case/punctuation/whitespace collapsed) against all existing
filings and within the run: the same role re-posted under a new URL or
route is the same lead and is never dispositioned twice. Entry shape
matches `renderFilings` / `saveFiling` exactly: `{ id ("fil-…"), company,
role, where, status, filed_at, date, reason, url, posted_at?, category?
(rejected only), check: { verdict, rules: [{ rule, status, evidence }] } }`.
`date` is `filed_at.slice(0,10)` (UTC), which is what the page's
`filingsToday()` actually compares.

### Evaluation — the sweep discipline (2026-10-15)

The engine evaluates exactly the way the Sweep Tracker's sweep does:

- **JD-first.** No verdict from a title or snippet: the full posting text
  is loaded before judging. A posting whose full text cannot be loaded is
  **not evaluated** — no disposition is recorded; the run's closeout
  activity line counts it ("N not evaluated").
- **Every screened posting is dispositioned exactly once** — `parked`
  (ready to apply) or `rejected` with a machine `category`
  (`not-remote`, `pay-outside-band`, `stale-posting`, `hands-on-duties`,
  `pre-sales`, `experience-mismatch`, `employer-excluded`,
  `always-reject`) and a human `reason`.
- **The secondary check** rides on every disposition: the 13 rules in
  canonical order (`full JD read`, `experience alignment`,
  `duplicate check`, `employer exclusions`, `100% remote US`, `pay band`,
  `posting freshness`, `tailored resume`, `veteran answer`,
  `screening answers`, `pre-sales bar`, `filing proof`,
  `hands-on duties`), each `pass | fail | grey` with evidence quoted
  from the posting. Filing-stage rules are honest greys at evaluation
  time; the page completes them (attested) when the user marks a lead
  filed.
- **Gate facts reject on sight** — excluded employer and always-reject
  terms are the posting-intrinsic exception: no JD is opened for an
  excluded employer, and the check says so.
- **Pay band:** the TOP of a published range must sit between
  `minimum_pay` and `maximum_pay`; unpublished pay is always eligible.
- **Remote language:** "fully remote" / "remote or hybrid" / "work from
  anywhere" are eligible; a stated required office/hybrid schedule
  rejects, quoting the sentence; non-US-restricted locations reject.
- **Freshness:** postings older than `posting_max_age_days` reject;
  boards that publish no date are dated from discovery.
- **Hands-on / pre-sales:** whole-role tests with quoted duties — a
  percentage-of-time coding role, a quota-carrying role — never a
  keyword brush.
- **Experience alignment:** the posting's named skill requirements vs
  the résumé (detection skills + full text); a core mismatch fails only
  when 3+ skills are required and the résumé covers none.
- **Workarounds before a judgment reject stands:** a reject judged from
  an aggregator feed (RemoteOK / Arbeitnow) is re-judged against the
  employer's own ATS board copy of the same role when one exists — the
  board text governs, and the check gains a `workarounds tried` entry
  either way.

### Engine appends into `activity.json`

One entry at closeout (and one on a stopped run), in the app's exact
`logActivity` shape — `{ id ("act-…"), at, kind: "run", message }`, unshifted,
list capped at 400:

> `Hunt engine run complete: 599 postings checked, 26 ready-to-apply leads, 0 rejected.`

### Commits the page will see on `data/`

`hunt: run started` → `hunt: progress` (after every employer, every lane, and
the pre-closeout stage update) → `hunt: run complete` (or `hunt: run stopped`).
A failed `git push` never crashes the run; it is retried at the end.

## Discovery sources (the only network calls, plus git)

Per sector-lane employer, slug candidates (name normalization + a small
curated map) are tried in order — first `200` with a jobs array wins:

1. Greenhouse — `GET https://boards-api.greenhouse.io/v1/boards/<slug>/jobs`
   (job detail fetched per title-matching posting for description text;
   capped at 60 detail fetches per board)
2. Lever — `GET https://api.lever.co/v0/postings/<slug>?mode=json`
3. Ashby — `GET https://api.ashbyhq.com/posting-api/job-board/<slug>`

Caps: 200 postings evaluated per board; 15s fetch timeout; any single
employer failure is logged and skipped, never fatal.

Once per run, the free keyless feeds are also evaluated the same way, with
finds recorded under their true source: RemoteOK (`https://remoteok.com/api`)
and Arbeitnow (`https://www.arbeitnow.com/api/job-board-api`).

Evaluation order per posting: title match vs saved titles (≥2 shared
significant tokens, or the saved title's head/family word) → excluded employer
(skip silently) → always-reject keyword (→ `rejected`) → remote-only with no
remote signal (→ `rejected`, "Not remote") → stated max pay below
`minimum_pay` (→ `rejected`, "Pay below your minimum") → otherwise a `parked`
ready-to-apply lead with a `check` record (title pass; remote pass/grey;
pay pass/grey).

## Honesty rules (do not weaken)

- The engine **never** creates `status: "filed"` filings. It cannot submit
  applications; ready matches are parked leads that tell the user to open the
  posting, apply, and record the filing.
- Board lanes (LinkedIn, Indeed, Dice, …) have no keyless server API. They are
  marked `manual` with detail: *"LinkedIn/Indeed/Dice searches run in your
  signed-in browser; the engine covers employer boards directly."* The engine
  does not fake searching them.
- Lane details always name what really happened (board found / no public board
  found / feed unavailable), never a fabricated search.

## Contract mismatches found in `index.html` (for the page wiring pass)

1. **Activity field name.** The task brief said entries are
   `{ id, at, kind, text }`; the app actually uses **`message`**
   (`logActivity`, line ~359). The engine mirrors the app.
2. **Dashboard stages are hardcoded, not read from `runs.json`.**
   `renderDashboard` (~line 1213) derives the five stage pills from
   `runs.state` alone (running → Preparing/Discovering "Active", the rest
   "Queued"). It never reads `current_run.stages`, so Evaluating/Filing/
   Closeout will never show Active and stage `detail` text is invisible. The
   engine writes real stages per the contract above — the page should render
   `current_run.stages` (name/state/detail) when present and fall back to the
   current derivation otherwise.
3. **No polling.** Nothing in the page re-reads the repo while the dashboard
   sits open (no `setInterval`; `storeLoad` runs at login/navigation). For
   lanes/stages/counts to visibly move, the page should poll while
   `runs.state === "running"` — e.g. every 30s re-load `runs`, `filings`,
   `activity` and re-render the dashboard.
4. **Lane `status`/`detail` are written but not displayed.** `laneProgress`
   uses only `done`/`total`; `openLanePanel` shows "% covered · run state".
   Surfacing the entry's `detail` in the lane panel (and the card) is what
   makes the board evidence ("Greenhouse board found — 200 postings checked")
   visible to the user.
5. **Legacy shapes in the wild.** The older test repos (e.g.
   `HueTX/gmaj-test-data`) store `coverage.json` flat (`titles`/`lanes` at top
   level, no `saved` wrapper) and `activity.json` as a bare array. The current
   app shape (`defaultsFor`) is authoritative; the engine tolerates the legacy
   forms (bare-array activity is wrapped; flat coverage simply yields an empty
   saved set) but the page should not write the legacy shapes anymore.

## Local test evidence (2026-10-15)

Test repo `/tmp/gmaj-engine-test` seeded from `HueTX/gmaj-test-data` with
`coverage.saved` = titles `["Data Analyst", "Senior Data Analyst"]`, lanes
`Technology employers` (sector: Stripe, Not A Real Company LLC) + `LinkedIn`
(board). Greenhouse reachability confirmed first (`200`, jobs array).

- **Run 1** (rules: remote_only off, no minimum): exit 0 in ~15s. Stripe's
  Greenhouse board resolved; lane detail recorded
  `Stripe: Greenhouse board found — 200 postings checked · Not A Real Company LLC: no public board found`;
  LinkedIn lane `manual` with the honesty detail. 599 postings evaluated
  (200 Stripe + 399 feed postings); 26 parked leads (11 Greenhouse, 10
  Arbeitnow, 5 RemoteOK), 0 rejected, **zero `filed`**. History entry: all
  five stages `done`, `ended_at` set. Activity summary entry written.
- **Run 2** (dedupe): exit 0; 599 re-checked, **0 new filings** (26 unique
  company+role+url keys), history grew to 2 runs, no crash.
- **Stop closeout**: with `runs.state` flipped to `stopped`, the engine exited
  0 via `hunt: run stopped`; unfinished stages marked `stopped`, run moved to
  history, activity entry written.
- **Strict rules** (remote_only on, minimum `$400,000/yr`, always-reject
  `["Intern"]`): 599 checked → 12 parked, 14 rejected — `Not remote` ×11,
  `Matches your always-reject list: Intern` ×2, `Pay below your minimum` ×1,
  each with check evidence.
