# TrackEasy / Jiya — TODO

Snapshot of every model, code, and operational issue discovered. Each item has:
- **Status**: open / done / partially-done
- **Where**: file path + line if known
- **What** the problem is
- **Fix** suggested approach
- **Effort**: S (≤1 hour) · M (½ day) · L (1+ days)

Organized by priority. References use clickable paths from repo root.

---

## A. Done (closed during this session, kept here for the audit trail)

| # | Where | What was wrong | Fix |
|---|---|---|---|
| A1 | [fraud-service/fraudServer.js:330,336](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L330) | `ensemble_features: { ruleScore, ... }` referenced undefined `ruleScore` (the var is `riskScore`). ANN master brain threw `ReferenceError` on every eval → ensemble silently disabled | Pass `ruleScore: riskScore` |
| A2 | [fraudServer.js](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L121) | `xaiExplanation` declared inside nested try block but referenced outside in `FraudAlert.save()` → ReferenceError → no explanation ever saved | Hoisted to handler scope |
| A3 | [fraudServer.js:259](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L259) | Read `transactionDetails.totalSum` but server sends `totalAmount` → autoencoder always saw `amount: 0` → fired on every single transaction in the app's history | Read `totalAmount` (with `totalSum` fallback) |
| A4 | [server/routes/orders.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/routes/orders.js#L85) | Server velocity rule's message said "5× average" but code only required `> average` | Now actually 5× for amount, 3× for quantity, 5-item floor |
| A5 | [middleware/auth.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/middleware/auth.js) + [routes/auth.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/routes/auth.js#L102) | Block was global — blocked users couldn't even log in or browse | Scoped to order-placement routes only via `enforceOrderBlock()` helper |
| A6 | User schema + [fraudServer.js:361](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L361) | Auto-block was permanent | Added `blockedAt` + `blockedUntil`; `FRAUD_BLOCK_COOLDOWN_MS` env (default 10 min); lazy-expiry on next request |
| A7 | [scripts/adminDashboard.js:1242,1252-1258](Jiya%20project/TrackEasy-3.O/TrackEasy/server/public/scripts/adminDashboard.js#L1242) | Pre-existing escaped backticks `\`...\`` made the **entire admin ES module fail to parse** — every admin JS feature was silently dead | Removed backslashes, bumped cache-buster |

---

## B. Critical / open bugs

### B1 — ANN ensemble decision is asymmetric · **M**

**Where:** [fraudServer.js:344-377](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L344)

**Problem:** Master brain's `action = 'requires_otp'` (when `brainProb > 0.9`) gets overwritten by the later `if (riskScore > 8) action = 'block'`. So the ensemble can only **escalate** moderate scores, never **reduce** a score=10 false positive back to OTP. The "ensemble" is asymmetric — more decoration than a real arbiter.

**Fix:** Re-order so the master brain probability participates in the final decision:
```js
// Use master brain probability as the source of truth when available
let finalProb = brainProb || (riskScore / 10);
if (finalProb > 0.9 || riskScore === 10) action = 'block';
else if (finalProb > 0.6) action = 'requires_otp';
else if (finalProb > 0.3) action = 'warning';
else action = 'allow';
```

### B2 — EventLog has no decay → past failures haunt forever · **M**

**Where:** [fraudServer.js:120-122](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L120) (`EventLog.find().sort().limit(20)`)

**Problem:** The fraud-service grabs the **last 20 events ever** for the user. After a single bad day (failed payments, blocked attempts) those events sit in the log indefinitely and keep poisoning the LSTM input + R2 (`failedPayments ≥ 2`). User has no path to recover.

**Fix:** Add a time window — `EventLog.find({ userId, timestamp: { $gte: now - 24h } })`. Make the window configurable via env (`FRAUD_EVENT_WINDOW_MS`).

### B3 — RF / XGBoost / Isolation Forest are dead code · **S**

**Where:** [ml/ml_service.py:177-208](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L177) — endpoints exist; no JS caller in [fraudServer.js](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js)

**Problem:** Three models loaded into memory at every container start (slow boot, ~150 KB joblib + several MB of TF) but never called. Documentation advertises "7-model ensemble" — actual is 4.

**Fix (one of):**
- a) Wire them in: call all three in parallel, vote/average their probabilities, feed into the ensemble feature vector. **Recommended.**
- b) Drop them from the image: remove `rf_model.joblib`, `xgb_model.json`, `iso_forest_model.joblib`, the `/predict/rf`, `/predict/xgb`, `/predict/if` endpoints, and the import-side overhead.

### B4 — Permanent isBlocked rejects manual block bypass via cooldown · **S**

**Where:** [admin.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/routes/admin.js#L146) and [manager.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/routes/manager.js#L166)

**Problem:** Manual blocks correctly *don't* set `blockedUntil`. But there's no UI distinction: admin can't tell from the table alone whether a block is "auto, expires at HH:MM" vs "manual, permanent" until they read the reason cell. Already partially shown in the new Blocked-Users tab — could be a colored chip.

**Fix:** Add a "Type" column to the Blocked-Users table — `Auto` chip (amber) or `Manual` chip (red). UX polish, but useful.

### B5 — Stripe boots with placeholder, fails silently in card flow · **S**

**Where:** [orders.js:7](Jiya%20project/TrackEasy-3.O/TrackEasy/server/routes/orders.js#L7)

**Problem:** `STRIPE_SECRET_KEY=sk_test_placeholder...` lets the server boot but **any real card payment will throw**. The frontend handler does not surface this clearly — user sees "Order failed" with no explanation.

**Fix (one of):**
- a) Lazy-init Stripe inside the route handler so missing key shows up as a clean response.
- b) Detect placeholder key at boot, log a warning banner, and short-circuit `paymentMethod === 'Card'` to return a useful error.
- c) Hide the `Card` option in the UI when no real key is configured.

---

## C. Model quality (the real elephant in the room)

### C1 — LSTM is trained on **3 unique sequences** · **L**

**Where:** [scripts/generate_behavior_data.js](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/scripts/generate_behavior_data.js) — synthesizes 1000 copies each of `1,2,2,3,2,4,6,2,2,2`, `2,2,2,2,2,2,2,2,2,2`, `5,5,5,5,5,5,5,5,5,5`

**Problem:** Model is template-matching, not learning. Returns 0.9999 for any sequence dominated by 5s, near-random for novel sequences.

**Fix:**
- Generate diverse training sequences: random walks over the event vocabulary with realistic transition probabilities, varied lengths, padding patterns.
- Include negative samples that are "borderline" (some failed payments interspersed with normal flow) labelled as `0`.
- Add "edge cases" that should be normal but resemble bot patterns superficially.
- Consider transitioning from integer-encoded LSTM to a small Transformer with positional embeddings — better for sequence pattern semantics.

### C2 — Autoencoder distribution mismatch · **M**

**Where:** [ml/train_autoencoder.py](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_autoencoder.py), [ml_service.py:160](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L160)

**Problem:** Synthetic training data doesn't match real INR retail volumes. Threshold 2.5 is too sensitive — even ₹220 grocery orders flag.

**Fix:**
- Re-derive `normal_transactions.csv` from actual seeded `Order` collection (or import a public Indian e-commerce dataset like the one in `Jiya project/Fraudulent_E-Commerce_Transaction_Data_2.csv` — 6 MB already in the repo).
- Re-fit the StandardScaler to that data.
- Calibrate threshold to give ~5 % false-positive rate on a held-out normal set.
- Consider **percentile-based threshold** (e.g. 95th percentile MSE on training set) rather than a magic number.

### C3 — GNN is dormant for any user not in the static graph · **L**

**Where:** [ml_service.py:142-144](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L142), [ml/node_map.json](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/node_map.json)

**Problem:** Brand-new users (anyone signed up after training) get `probability: 0` and the GNN can't fire for them — possibly the most common case in production.

**Fix:**
- Add a periodic graph refresh job that:
  1. Reads all users from Mongo
  2. Builds the user-similarity graph (shared address / phone prefix / device fingerprint)
  3. Re-runs `train_gnn.py`
  4. Hot-reloads the new model into the running ml-service
- For interim: when user not in graph, fall back to a "neighborhood lookup" — find users sharing fingerprint/address/phone in DB, use their historical fraud rate as the prob. Cheap and gives a non-zero signal.

### C4 — Master brain ensemble has no validation · **L**

**Where:** [ml/train_ann.py](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_ann.py), [ann_master_dataset.csv](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ann_master_dataset.csv)

**Problem:** The ANN learns to combine the 6 features but its training data is **also synthetic** — manufactured combinations of the upstream signals. There's no labeled real-world dataset of "this transaction was fraud → these were the model outputs". So the ensemble's probability calibration is meaningless.

**Fix:**
- Once we have at least a few hundred real `FraudAlert` records labelled by humans (admin marks them as confirmed-fraud or false-positive), retrain the ANN on those.
- Use logistic regression as a baseline — if a 6-input LR matches the ANN, the ANN is overkill.
- Add proper train/val/test split + AUC reporting.

### C5 — Biometric "model" is rule-based · **S**

**Where:** [ml_service.py:246+](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L246) (`/predict/biometrics`)

**Problem:** Despite being on the ML server, the biometric check is just a rule cascade (mouse moves, keystroke count, etc.) — no trained model. Documentation/diagrams suggest otherwise.

**Fix:**
- Be honest: rename the endpoint, move it to `fraudServer.js` as another rule, OR train a real classifier on labelled session telemetry.

---

## D. Architecture / Operational

### D1 — Fraud-service writes side-effects from a "scoring" function · **M**

**Where:** [fraudServer.js:365-372](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L365), [fraudServer.js:380-388](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L380)

**Problem:** `evaluate-transaction` both **scores** AND **mutates** state (`User.findByIdAndUpdate({isBlocked: true})` + `FraudAlert.save()`). Mixing pure scoring with side effects makes the function untestable and hard to reason about.

**Fix:** Split into two endpoints:
- `POST /evaluate` → returns `{riskScore, action, reasons, explanation}`. **No DB writes.**
- The server (orders.js) decides what to do with the response and writes side-effects itself.

### D2 — Browser-side hardcoded `localhost:5002` · **S**

**Where:** [server/public/scripts/customerDashboard.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/public/scripts/customerDashboard.js#L298), [fraudGraph.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/public/scripts/fraudGraph.js#L9), [fraudDashboard.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/public/scripts/fraudDashboard.js#L8)

**Problem:** Several browser-side `fetch('http://localhost:5002/...')` calls. Works in local Docker (port-mapped) but breaks if the app is deployed behind a reverse proxy or a non-localhost domain.

**Fix:** Reverse-proxy `/api/fraud/*` through the trackeasy server (Express → fraud-service), drop the second port from the browser entirely. Keeps the architecture simpler and removes CORS surface.

### D3 — JWT secret is a dev placeholder · **S**

**Where:** [docker-compose.yml](Jiya%20project/TrackEasy-3.O/TrackEasy/docker-compose.yml#L53)

**Problem:** `JWT_SECRET: devsecret_change_in_production`. Anyone can mint admin JWTs.

**Fix:** Refuse to start if `JWT_SECRET === 'devsecret_change_in_production'` AND `NODE_ENV === 'production'`. Generate via `openssl rand -hex 32` for any non-local deploy.

### D4 — No structured logging, no log levels · **M**

**Where:** All Node services use `console.log`/`console.error` with emoji prefixes.

**Problem:** Hard to grep, no JSON output for log aggregators, no log level filter.

**Fix:** Adopt `pino` (lightweight) or `winston`. Emit structured records with `level`, `service`, `userId`, `riskScore`. Keep the emoji prefixes in development only.

### D5 — No tests · **L**

**Problem:** No unit tests, no integration tests. Every fix in this session was verified by hand-curl.

**Fix (incremental):**
- Start with **integration tests for `enforceOrderBlock`** and the 11 fraud rules. Synthesize EventLog/Order docs in-memory and assert score breakdown.
- Add Playwright/Cypress for the customer checkout flow + the new admin Blocked Users + Inference Playground views.
- CI: GitHub Actions running `docker compose up -d`, then `npm test`.

### D6 — No CI · **S**

**Where:** Repo root

**Problem:** Pushed changes haven't been built/run automatically. Cache-busted JS would break for an offline user without you noticing.

**Fix:** Add `.github/workflows/ci.yml` that runs `docker compose build` and a smoke test (curl `/`, `/api/fraud/alerts`, `/docs`) on every push.

### D7 — Dockerfiles run as root · **S**

**Problem:** All three images run as `root`. Security smell.

**Fix:** `USER node` for Node images, `USER nobody` for the Python image. Make sure files have correct ownership before `USER` swap.

---

## E. UX polish

### E1 — Customer block modal can't be reopened · **S**

**Where:** [scripts/customerDashboard.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/public/scripts/customerDashboard.js)

**Problem:** Once you close the "Transaction Blocked" modal, there's no way to see the reasons again. A blocked user has no record on the dashboard.

**Fix:** Persist the latest fraud response in localStorage and add a "View last block details" button on the dashboard while `isBlocked` is true.

### E2 — No "test as another customer" toggle · **S**

**Where:** Inference Playground

**Problem:** Useful for demos to switch between "Alice (clean history)", "Eve (fraud-flagged history)", or "Bob (mixed)" quickly. Currently must scroll the dropdown.

**Fix:** Add three quick-pick buttons that auto-fill the customer + a representative cart preset.

### E3 — Admin Blocked Users — no "Unblock all" · **S**

**Problem:** During demo iteration we keep needing to unblock everyone. No bulk action in the UI.

**Fix:** Add an "Unblock all (auto-blocks only)" button next to Refresh.

### E4 — No fraud-alerts panel for the customer · **M**

**Problem:** Customer doesn't see their own historical fraud alerts (helpful for transparency / compliance).

**Fix:** Add a "Security activity" section in the customer dashboard showing past `FraudAlert` records for that user, with reasons + action taken + appeal CTA.

### E5 — Inference Playground only does customer simulation, not server-side velocity precheck for real · **S**

**Where:** [admin.js inference-playground](Jiya%20project/TrackEasy-3.O/TrackEasy/server/routes/admin.js)

**Problem:** Velocity rules are *displayed* but not actually enforced in the playground — they're shown for educational value. Could mislead someone into thinking the playground replicates the production decision exactly.

**Fix:** Add a small note "Server-side velocity rules below are shown for explanation; production order placement also runs them in `routes/orders.js`."

### E6 — Refresh button on Inference Playground · **S**

**Problem:** Re-running takes a click into the dropdown — no obvious "run with same params" button.

**Fix:** Already there (`Run Inference`) but label could double as "Re-run" once a result is on screen.

---

## F. Documentation

### F1 — README + PIPELINE.md don't yet reflect the latest changes · **S**

**Where:** [README.md](README.md), [PIPELINE.md](PIPELINE.md)

**Problem:** Both docs were written before the session's bug fixes. They still describe the asymmetric ensemble and unfixed autoencoder bug as "known gaps" but the actual fixes shipped.

**Fix:** Sweep both docs once the open items above stabilize. Add a screenshot of the Inference Playground.

### F2 — No model card / honesty section · **M**

**Problem:** Users don't know the LSTM was trained on 3 templates.

**Fix:** Add `MODELS.md` documenting each model's training data, dataset size, known limitations, and intended use. Be explicit about the synthetic origins.

---

## Suggested ordering for next iteration

If you can only do **5 things next**, pick:

1. **B2** — EventLog time window (M). Single biggest UX improvement; fixes the "why does my account stay flagged" complaint.
2. **B1** — Reorder action mapping so master brain participates symmetrically (M). Ensemble starts paying off.
3. **C2** — Re-fit autoencoder threshold from real distribution (M). Stops false-positive flagging on small orders.
4. **D5** — Smoke tests for the 11 rules (L, but worth it). Future regressions get caught.
5. **F1 + F2** — Refresh README + PIPELINE.md, write MODELS.md (M total). Anyone else picking up the repo will appreciate this.
