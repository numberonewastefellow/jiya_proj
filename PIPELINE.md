# TrackEasy Fraud Detection — Pipeline

End-to-end walkthrough of what happens when a customer clicks **"Make Payment"**. Sourced by tracing [server/routes/orders.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/routes/orders.js), [fraud-service/fraudServer.js](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js) and [fraud-service/ml/ml_service.py](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py).

## TL;DR

```
Browser  ──POST /api/orders──▶  server  ──POST /evaluate-transaction──▶  fraud-service
                                                                             │
                                                                             ├── rule layer (11 checks, sum points)
                                                                             ├── LSTM  /predict/behavioral   → +5 if prob>0.85
                                                                             ├── GNN   /predict/ring         → +6 if prob>0.85
                                                                             ├── Auto  /predict/anomaly      → +4 if mse>2.5
                                                                             ├── Bio   /predict/biometrics   → +9 if bot
                                                                             └── ANN   /predict/master       → may escalate to OTP
                                                                             ▼
                                                                  riskScore = min(10, Σ)
                                                                  action   = block (>8) | otp (>6) | warn (>3) | allow
                                                                             │
                     ◀── fraudResult ───────────────────────────────────────┘
server decides:
  block    → 403 "Transaction paused…", user already marked isBlocked
  otp      → generate 6-digit OTP, save to user.otp, return 403 with requiresOTP:true
  allow    → write Order, charge Stripe (or mark COD), return 201
```

## Workflow diagram

```
┌────────────────────┐
│ Customer clicks    │
│ "Make Payment"     │
└─────────┬──────────┘
          │ POST /api/orders
          │ body = { items, totalAmount, paymentMethod, biometrics, hp_trap }
          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  SERVER  ·  server/routes/orders.js :: POST '/'                          │
│                                                                          │
│  Stage A — server-side velocity precheck (lines 16-59)                   │
│    · loads user's past orders                                            │
│    · if currentQty > 2× avg                    → requiresOTP = true      │
│    · if currentAmount > 5× avg                 → requiresOTP = true      │
│    · if payment FAILED count > 3 (last 24h)    → requiresOTP = true      │
│                                                                          │
│  Stage B — delegate to fraud-service (lines 62-93)                       │
│    POST http://fraud-service:5002/api/fraud/evaluate-transaction         │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  FRAUD-SERVICE  ·  fraud-service/fraudServer.js                          │
│                    POST /api/fraud/evaluate-transaction                  │
│                                                                          │
│  riskScore = 0                                                           │
│  violationReasons = []                                                   │
│                                                                          │
│  RULE LAYER  (11 checks, each may add to riskScore)                      │
│   R1  addToCart > 5 in recent events          +1 per event               │
│   R2  failedPayments ≥ 2 in recent events     +4                         │
│   R3  login → checkout < 15s                  +3                         │
│   R4  itemCount > 3× user's avg AND ≥ 5       +7                         │
│   R5  geo-speed > 1000 km/h & >50 km          +8                         │
│   R10 checkout dur < 1/3 of user's typical    +10, action=block          │
│   R11 honeypot field non-empty (hp_trap)      +20, action=block          │
│                                                                          │
│  ML-LAYER  (specialist models, called in sequence over HTTP)             │
│   R6  LSTM   /predict/behavioral  prob > 0.85 → +5                       │
│   R7  GNN    /predict/ring        prob > 0.85 → +6                       │
│   R8  Auto   /predict/anomaly     is_anomaly  → +4                       │
│   R9  Bio    /predict/biometrics  is_bot      → +9                       │
│                                                                          │
│  MASTER BRAIN  (ensemble ANN over the above)                             │
│   /predict/master + /predict/explain                                     │
│   brainProb > 0.90  →  action = requires_otp + SHAP-like explanation     │
│                                                                          │
│  riskScore = min(10, riskScore)                                          │
│  if riskScore > 8 : action='block'  AND  User.findByIdAndUpdate(         │
│                                             { isBlocked: true, … })     │
│  elif riskScore > 6 : action='requires_otp'                              │
│  elif riskScore > 3 : action='warning'                                   │
│  else               : action='allow'                                     │
│                                                                          │
│  Always: FraudAlert.save({ userId, riskScore, violationReason, ... })    │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │  { riskScore, action, reasons, explanation }
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  SERVER (resumed)                                                        │
│   action = block   → 403 "Transaction paused for security review."       │
│   action = otp /                                                         │
│   velocity-otp     → generate 6-digit OTP, save to user.otp              │
│                       return 403 { requiresOTP:true, demoMode, demoOtp } │
│   action = allow   → new Order(...).save(),                              │
│                       (Card/UPI → paymentStatus=Paid, mock transactionId)│
│                       return 201 { success:true, order }                 │
└──────────────────────────────────────────────────────────────────────────┘
```

## Stage A — server-side velocity precheck

[server/routes/orders.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/routes/orders.js) triggers OTP **before even calling fraud-service** when:

| Trigger | Threshold |
|---|---|
| Current order item count | `> 2 ×` user's historical average |
| Current order ₹ amount | `> 5 ×` user's historical average |
| Payment failures in last 24h | `≥ 3` |

Also saves a `FraudAlert` with reason `"High value spike: Current ₹X is > 5x Previous"`.

**Example:** Alice has 3 past orders averaging ₹627. She submits a ₹79,980 order → `79,980 > 5 × 627` → `requiresOTP = true` purely from server-side rule, regardless of ML.

## Stage B — fraud-service rule layer

[fraud-service/fraudServer.js:123-320](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L123-L320) runs 11 checks. Each adds to `riskScore`. These are deterministic Javascript, **no ML involved**.

### R1 — Cart-add frequency (lines 130-135)
```js
if (addToCartEvents.length > 5) {
    riskScore += addToCartEvents.length * 1;
    violationReasons.push(`High frequency cart additions (${addToCartEvents.length} items)`);
}
```
**Trigger:** Rapidly add 6+ items to cart in one session (from `EventLog` collection).

### R2 — Payment failure cluster (lines 138-142)
`≥ 2` payment_failed events in recent history → `+4`.
**Trigger:** Fail card payment twice.

### R3 — Fast checkout after login (lines 145-150)
Login → checkout gap `< 15s` → `+3`.
**Trigger:** Script a login immediately followed by order POST.

### R4 — Historical quantity anomaly (lines 152-170)
```js
if (currentItems > 3 × userAvgItems && currentItems ≥ 5) riskScore += 7;
```
**Trigger (alice):** past avg 3 items → current cart 20 items → fires with +7.

### R5 — Geospatial "Superman" (lines 172-203)
Uses `geoip-lite` to resolve the request IP, compares to the most recent event with a location. If implied speed > 1000 km/h over > 50 km → `+8`.
**Trigger:** Log in from Mumbai IP, then from Tokyo IP within minutes.

### R10 — Maniacal checkout speed (lines 298-319)
Compares `biometrics.duration` (ms since cart shown) to `user.lastCheckoutDuration`. If now is 3× faster than previous → `+10` **and sets `action='block'` immediately**.

### R11 — Honeypot trap (lines 274-280)
Frontend renders an invisible hidden field. Bots filling it set `hp_trap=true` → `+20` **and immediate block**.

## Stage C — specialist ML models

Four models are called sequentially over HTTP to `ml-service:8000`. Each inference reads a pre-trained `.h5` / `.joblib` loaded at container startup.

### R6 — LSTM behavioral sequence
- **What it does:** classifies the last 10 user event types (login, add_to_cart, payment_failed, …) as "normal shopper" vs "bot / fraudster".
- **Endpoint:** `POST /predict/behavioral`
- **Input:** `{ sequence: [1, 2, 2, 2, 4, 5, 5, 5, 4, 6] }` — integer-encoded events, padded/truncated to length 10.
- **Output:** `{ "probability": 0.97 }`
- **Fires:** `+5` when `probability > 0.85`.
- **Event codes** (`EVENT_MAP` in fraudServer.js):
  ```
  login=1  add_to_cart=2  remove_from_cart=3
  checkout_attempt=4  payment_failed=5  payment_success=6
  ```
- **Model file:** [fraud-service/ml/behavior_model.h5](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/behavior_model.h5)

### R7 — GNN fraud ring
- **What it does:** graph neural network over a user-graph where edges connect users who share address / phone / device. Flags nodes in tight clusters with known fraudsters.
- **Endpoint:** `POST /predict/ring`
- **Input:** `{ userId: "69ebb…" }` — resolved via `node_map.json`.
- **Output:** `{ "probability": 0.71 }` or `{ "probability": 0.0, "reason": "Not in graph" }`
- **Fires:** `+6` when `probability > 0.85`.
- **Model:** [gnn_model.h5](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/gnn_model.h5) + static `graph_nodes.csv`, `graph_edges.csv`.

### R8 — Autoencoder unsupervised anomaly
- **What it does:** reconstructs a 4-D transaction vector `[amount, itemCount, hour, day]`. High reconstruction error = doesn't match the shape of "normal" transactions.
- **Endpoint:** `POST /predict/anomaly`
- **Input:** `{ transaction: { amount: 79980, items: 1, hour: 18, day: 5 } }`
- **Output:** `{ "mse": 3.24, "is_anomaly": true, "threshold": 2.5 }`
- **Fires:** `+4` when `is_anomaly` is true (`mse > 2.5`).
- **Model:** [autoencoder_model.h5](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/autoencoder_model.h5) + `scaler.joblib`.

### R9 — Behavioral biometrics
- **What it does:** looks at mouse/keyboard micro-signals (keystrokeCount, mouseMoves, eventCount, duration) captured by the dashboard JS. Hybrid rule+ML classifier.
- **Endpoint:** `POST /predict/biometrics`
- **Input:** `{ eventCount, keystrokeCount, mouseMoves, duration, ... }`
- **Output:** `{ "is_bot": true, "bot_probability": 0.92, "reasons": ["no_mouse_movement", "zero_dwell_time"] }`
- **Fires:** `+9` when `is_bot` is true.
- **Note:** only runs if `biometrics.eventCount > 0` in request body.

## Stage D — ANN master brain (ensemble)

Once the 4 specialist models and rule score are computed, the fraud-service calls one more model to compute an **ensemble probability** across all signals.

- **Endpoint:** `POST /predict/master`
- **Input (6-D feature vector):**
  ```json
  {
    "ensemble_features": {
      "ruleScore":   4,
      "lstmProb":    0.97,
      "gnnProb":     0.12,
      "autoMSE":     3.24,
      "geoSpeed":    0,
      "clusterSize": 1
    }
  }
  ```
- **Output:** `{ "probability": 0.94 }`
- **Effect:** if `probability > 0.90`, forces `action='requires_otp'` regardless of whatever the sum-of-rules would have decided.
- **Model:** [ann_fraud_brain.h5](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ann_fraud_brain.h5), trained on `ann_master_dataset.csv`.

### XAI explanation (`/predict/explain`)

Runs the ANN with each of the 6 features perturbed to its baseline and returns how much the final probability changed — SHAP-like local attribution, saved onto the `FraudAlert.explanation` field so the admin dashboard can show **why** a transaction was flagged.

### Known bug — ensemble currently disabled

In [fraudServer.js:330](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L330) the feature bag uses `ruleScore` but the actual variable is `riskScore`. Every call throws `ReferenceError: ruleScore is not defined` and the master brain never influences the decision. Visible in the logs as:
```
[BRAIN ERROR] Could not reach ML service for ensemble/explanation: ruleScore is not defined
```
Fix is a one-line rename. Until fixed, only the rule layer + 4 specialist models decide.

## Stage E — action mapping and side effects

[fraudServer.js:358-377](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L358-L377):

```js
riskScore = min(10, riskScore);

if (riskScore > 8)        action = 'block';         // + User.isBlocked = true
else if (riskScore > 6)   action = 'requires_otp';
else if (riskScore > 3)   action = 'warning';
else                      action = 'allow';

FraudAlert.save({ userId, riskScore, violationReason: reasons.join(' | '), explanation });
return { riskScore, action, reasons, explanation };
```

| Action | Server behaviour | Side effects in DB |
|---|---|---|
| `allow` | create Order, return 201 | FraudAlert (status=Resolved) |
| `warning` | create Order, return 201 | FraudAlert (Pending) |
| `requires_otp` | generate OTP, return 403 `requiresOTP:true` | `user.otp` set, FraudAlert (Pending) |
| `block` | return 403 "Transaction paused" | **`user.isBlocked=true`**, FraudAlert (Pending) |

Note: **the 'block' side effect is permanent until an admin unblocks.** That's what bit Alice.

## Worked example — Alice's real block from this demo

Context: alice has 3 seeded past orders averaging ~3 items, ~₹627. You submitted:
```
POST /api/orders
{ items: [{ name: "Bluetooth Speaker", price: 3999, quantity: 20 }],
  totalAmount: 79980, paymentMethod: "COD" }
```

Actual log output from `docker compose logs fraud-service`:

```
[DEEP LEARNING FLAG]  User 69ebb… flagged with high fraud probability: 0.999997
[ANOMALY FLAG]        Transaction for 69ebb… flagged as outlier by Autoencoder.
[BRAIN ERROR]         Could not reach ML service: 'ruleScore is not defined'
[AUTO-BLOCK]          User 69ebb… blocked due to critical risk score of 10.
```

Score breakdown:

| Source | Pts | Why |
|---|---|---|
| R4 historical quantity (20 items vs avg ~3, ≥5) | **+7** | matches the rule condition |
| R6 LSTM behavioral (prob 0.999997) | **+5** | untrained event sequence looks "bot-like" to the model |
| R8 Autoencoder anomaly | **+4** | `[79980, 1, …]` is far outside training distribution |
| Master Brain ensemble | — | crashed (the bug above) |
| **Sum** | **16 → capped at 10** | → `riskScore > 8` → `action=block` |

Server responded 403 "Transaction paused…" and fraud-service set `alice.isBlocked = true`. The OTP modal you then saw was actually from a **different** earlier attempt (server-side velocity spike alert, `+4` + server-side requiresOTP flag). When you submitted the OTP, `authMiddleware` hit `user.isBlocked === true` first and returned the "Your account has been blocked" message before OTP verification even ran.

## How to deliberately trigger each signal (for demo)

| Path you want to see | How to trigger |
|---|---|
| `allow` | small, reasonable order as a customer with some history |
| `warning` | one failed card payment, then retry |
| server velocity OTP | order ≥ 6× your history's avg ₹ |
| R4 quantity rule | cart of 10+ items when you've historically ordered 2-3 |
| R5 Superman | login via VPN in region A, then immediately again in region B |
| R6 LSTM | use `logBehavioralEvent('add_to_cart', ...)` in console to spam 10 cart adds, then checkout |
| R8 Autoencoder | extreme ₹ amount (6+ digits) with 1 item, odd hour |
| R10 maniacal speed | submit checkout in < (last_checkout_duration / 3) ms |
| R11 honeypot | manually `document.getElementById('order-confirm-bypass').value = 'x'` before submit |
| `block` | combine any two of R4 / R6 / R8 at max strength |

Watch it live:
```bash
docker compose logs -f fraud-service
```

## Endpoint reference (ml-service:8000)

| Endpoint | Called by fraud-service? | Input | Output |
|---|---|---|---|
| `POST /predict/behavioral` | ✓ | `{ sequence: int[10] }` | `{ probability }` |
| `POST /predict/ring` | ✓ | `{ userId }` | `{ probability, reason? }` |
| `POST /predict/anomaly` | ✓ | `{ transaction: {amount,items,hour,day} }` | `{ mse, is_anomaly, threshold }` |
| `POST /predict/biometrics` | ✓ | `{ eventCount, keystrokeCount, mouseMoves, duration, ... }` | `{ is_bot, bot_probability, reasons }` |
| `POST /predict/master` | ✓ | `{ ensemble_features: 6 fields }` | `{ probability }` |
| `POST /predict/explain` | ✓ | `{ ensemble_features }` | `{ final_prob, explanation[], base_value }` |
| `POST /predict/rf` | ✗ loaded but not wired | `{ ensemble_features }` | `{ probability }` |
| `POST /predict/xgb` | ✗ loaded but not wired | `{ ensemble_features }` | `{ probability }` |
| `POST /predict/if`  | ✗ loaded but not wired | `{ ensemble_features }` | `{ anomaly_score }` |

RF, XGBoost and Isolation Forest are shipped pre-trained and served, but no JS code currently invokes them. They're candidates for a future second-opinion layer on the ensemble.

## Summary of gaps you may want to address

1. **`ruleScore` typo** in [fraudServer.js:330](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L330) disables the master ANN ensemble.
2. **`block` is permanent** — no auto-expiry, no automatic demote to `requires_otp` after N minutes. Manual unblock only.
3. **RF / XGB / IF are unreached** — the code advertises a 7-model ensemble but only 4 specialist models + ANN participate.
4. **Fraud alerts from server velocity are missing `explanation`** — only fraud-service alerts populate the SHAP field.
5. **Biometric endpoint shape mismatch** — [biometrics payload](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L286) is forwarded raw; the ML side accepts a `dict` but the model weights assume a specific key ordering that isn't documented.
