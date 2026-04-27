# End-to-End Fraud Detection Workflow

How a single `POST /api/orders` flows through the entire pipeline — from the customer dashboard, through the rule engine, through the four trained models, to a final allow/warn/OTP/block decision and an audit alert in the database.

> Per-model deep-dives: [`LSTM.md`](LSTM.md) · [`GNN.md`](GNN.md) · [`Autoencoder.md`](Autoencoder.md) · [`ANN_Master_Brain.md`](ANN_Master_Brain.md).
> Top-level pipeline overview (rules R1–R11): [`PIPELINE.md`](../../PIPELINE.md).

---

## 1. The big picture

```
                   ┌──────────────────┐
                   │  Customer  UI    │  POST /api/orders  { items, totalAmount, ... }
                   └────────┬─────────┘
                            │
                            ▼
       ┌────────────────────────────────────────────────────────┐
       │  trackeasy server (Express, port 5000)                 │
       │  routes/orders.js                                      │
       │                                                        │
       │   1. enforceOrderBlock(userId)  → 403 if in cooldown   │
       │   2. server-side velocity rules (SV1, SV2, SV3)        │
       │      ├─ qty spike   (qty  > avgQty × 3, min 5)         │
       │      ├─ high value  (amt  > ₹50,000)                   │
       │      └─ amt spike   (amt  > avgAmount × 5)             │
       │   3. POST  http://fraud-service:5002/api/fraud/        │
       │           evaluate-transaction                         │
       │           { userId, transactionDetails, biometrics }   │
       └────────────────────────────┬───────────────────────────┘
                                    │
                                    ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  fraud-service (Express, port 5002)                         │
   │  fraudServer.js  → POST /api/fraud/evaluate-transaction     │
   │                                                             │
   │   R1  add_to_cart frequency       (+= n × 1)                │
   │   R2  ≥2 payment_failed events    (+= 4)                    │
   │   R3  checkout < 15s of login     (+= 3)                    │
   │   R4  qty > avgQty × 3, ≥5 items  (+= 7)                    │
   │   R5  Superman geo (>1000 km/h)   (+= 8)                    │
   │   R6  ─── LSTM /predict/behavioral ───  prob > 0.85 → +5    │
   │   R7  ─── GNN  /predict/ring       ───  prob > 0.85 → +6    │
   │   R8  ─── AE   /predict/anomaly    ───  is_anomaly → +4     │
   │   R9  Biometrics (bot detector)   (+= 9 if is_bot)          │
   │   R10 Maniacal speed              (+= 10, action=block)     │
   │   R11 Honeypot trap               (+= 20, action=block)     │
   │                                                             │
   │   ── ANN /predict/master  → brainProb                       │
   │   ── ANN /predict/explain → XAI contributions               │
   │                                                             │
   │   riskScore = min(10, riskScore)                            │
   │                                                             │
   │   action =                                                  │
   │     riskScore > 8   → block + auto-block user (cooldown)    │
   │     riskScore > 6   → requires_otp                          │
   │     riskScore > 3   → warning                               │
   │     else            → allow                                 │
   │     (brainProb > 0.9 also forces requires_otp)              │
   │                                                             │
   │   FraudAlert.save({ userId, riskScore, reasons, xai })      │
   │   → 200 { riskScore, action, reasons, explanation }         │
   └─────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                         (back to trackeasy server)
                                    │
                       ┌────────────┴────────────┐
                       │                         │
              action = 'allow'            action ∈ {warning,
              persist Order              requires_otp, block}
              200 { order, otp:false }   short-circuit, return
                                         403 { reason, riskScore,
                                                explanation,
                                                otpRequired? }
```

---

## 2. The four trained models at a glance

| Model | Endpoint | Input | Output | Threshold | Score impact |
|---|---|---|---|---|---|
| **LSTM** | `POST /predict/behavioral` | last 10 events (integers) | `probability` | `> 0.85` | **+5** |
| **GNN** | `POST /predict/ring` | `userId` | `probability` (or 0 if not in graph) | `> 0.85` | **+6** |
| **Autoencoder** | `POST /predict/anomaly` | `[amount, items, hour, day]` | `mse`, `is_anomaly` | `mse > 2.5` | **+4** |
| **ANN Master Brain** | `POST /predict/master` | 6-D ensemble vector | `probability` | `> 0.9` | escalates to **OTP** (no direct score) |
| **XAI** (same model, different endpoint) | `POST /predict/explain` | 6-D ensemble vector | per-feature contributions | — | display only |

Source of all thresholds: [fraudServer.js](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js).

---

## 3. Step-by-step trace of a single request

### Stage 0 — UI

The customer clicks "Place Order" on `customer-dashboard.html`. The page bundles the cart, the captured behavioural biometrics (mouse velocity, scroll jitter, etc.), and any honeypot field state, and POSTs to `/api/orders`.

### Stage 1 — `routes/orders.js` pre-flight

```js
1. validate JWT (middleware/auth.js)
2. enforceOrderBlock(userId)
   └─ if (user.blockedUntil && user.blockedUntil > now) → 403 with seconds remaining
3. compute serverReasons[] for SV1/SV2/SV3 spike rules
   └─ if SV1 fires (qty spike) → short-circuit to OTP, no fraud-service call
4. else → axios.post(`${FRAUD_SERVICE_URL}/api/fraud/evaluate-transaction`, { ... })
```

### Stage 2 — fraud-service R1–R5 (rules with no model)

These are the cheap deterministic rules. They look at MongoDB only.

### Stage 3 — fraud-service calls models in order

Calls are **sequential** (not parallel) — each subsequent rule depends on `riskScore` accumulated so far.

```
[R6] LSTM     → POST /predict/behavioral
[R7] GNN      → POST /predict/ring
[R8] AE       → POST /predict/anomaly
[R9] Biom.    → POST /predict/biometrics   (rule-based, lives in ml_service.py)
[Master] ANN  → POST /predict/master
[XAI]    ANN  → POST /predict/explain
```

If the ML service is down for any of these, the catch block logs the error and the rule contributes 0 — degrades gracefully.

### Stage 4 — final action mapping

After cap and master-brain escalation:

```js
riskScore = Math.min(10, riskScore);
if (riskScore > 8)  { action='block';        autoBlockUser(); }
else if (riskScore > 6) action = 'requires_otp';
else if (riskScore > 3) action = 'warning';
else                    action = 'allow';
if (brainProb > 0.9)    action = 'requires_otp';   // brain can escalate
if (riskScore > 8)      action = 'block';          // but block always wins
```

### Stage 5 — persist + reply

```js
FraudAlert.save({
    userId, transactionId, riskScore, violationReason,
    explanation: xaiExplanation,
    status: riskScore > 6 ? 'Pending' : 'Resolved'
});
res.json({ riskScore, action, reasons, explanation });
```

The trackeasy server then either persists the Order (allow) or returns 403 to the UI with the `reasons` and SHAP-bar `explanation` data.

---

## 4. Worked example #1 — clean order, ALLOWED

**Customer**: `alice` — 5 past orders, average 1.4 items, average ₹820. Just logged in 2 minutes ago. EventLog has the typical login-browse-checkout pattern.

**Cart**: 1 × ₹899 phone case. From Mumbai. Tuesday 14:00.

| Stage | Signal | Value |
|---|---|---|
| SV1–SV3 server velocity | qty=1 ≪ 5, amt=899 ≪ thresholds | none fired |
| R1 add_to_cart freq | 2 in last 20 events | not fired |
| R2 payment failures | 0 | not fired |
| R3 fast checkout | login was 120 s ago | not fired |
| R4 qty anomaly | 1 ≪ avg×3 | not fired |
| R5 geo Superman | 0 km/h | not fired |
| **R6 LSTM** | seq `[1,2,2,4,6,0,0,0,0,0]` (zero-padded) | prob ≈ 0.04 → not fired |
| **R7 GNN** | `alice` not in node_map | prob = 0 → not fired |
| **R8 AE** | `[899, 1, 14, 2]` → MSE ≈ 0.05 | not anomaly → not fired |
| R9 biometrics | human-like | not fired |
| R10/R11 | n/a | not fired |
| **ANN Master Brain** | `[0, 0.04, 0, 0.05, 0, 1]` | brainProb ≈ 0.06 → no escalation |

`riskScore = 0` → **action = `allow`**. Order persists. `FraudAlert` saved with `status='Resolved'`.

UI shows the standard order confirmation.

---

## 5. Worked example #2 — multi-signal fraud, BLOCKED

**Customer**: `mallory` — 1 past order. Logged in 10 s ago. EventLog of last 10 events: `[1, 5, 5, 5, 5, 5, 5, 5, 2, 4]` (login then 7 failed payments then 2 add-to-cart then checkout-attempt). It's 03:00 Sunday.

**Cart**: 12 items, ₹87,500.

| Stage | Signal | Value | Δ score |
|---|---|---|---|
| SV1 server qty spike | 12 > max(1×3, 5)=5 | fired (server short-circuits to OTP — but assume bypass for this example) | — |
| SV2 high value | 87,500 > 50,000 | fired | — |
| R1 add_to_cart freq | 2 in last 20 | not fired | 0 |
| R2 payment failures | 7 ≥ 2 | **fired** | **+4** |
| R3 fast checkout | login 10 s ago | **fired** | **+3** |
| R4 qty anomaly | 12 > avg(1)×3 AND ≥ 5 | **fired** | **+7** |
| R5 geo Superman | speed normal | not fired | 0 |
| **R6 LSTM** | seq `[1,5,5,5,5,5,5,5,2,4]` | prob ≈ 0.94 → **fired** | **+5** |
| **R7 GNN** | `mallory` in node_map, 3 of 4 neighbours flagged | prob ≈ 0.91 → **fired** | **+6** |
| **R8 AE** | `[87500, 12, 3, 0]` → MSE ≈ 6.8 | anomaly → **fired** | **+4** |
| R9 biometrics | jitter 0, perfect straight lines | bot → **fired** | **+9** |
| R10 maniacal speed | n/a | not fired | 0 |
| R11 honeypot | not interacted | not fired | 0 |

Raw sum before cap: `4 + 3 + 7 + 5 + 6 + 4 + 9 = 38` → `riskScore = min(10, 38) = 10`.

**ANN Master Brain**: input vector `[10, 0.94, 0.91, 6.8, 0, 1]` → `brainProb ≈ 0.99`.

**XAI** top contributions:
- `gnnProb` → +3.5
- `lstmProb` → +3.0
- `autoMSE` → +1.6
- `ruleScore` → +1.2

Action mapping: `riskScore=10 > 8` → `action = 'block'`.
- `User.findByIdAndUpdate(mallory, { isBlocked: true, blockedAt: now, blockedUntil: now + FRAUD_BLOCK_COOLDOWN_MS })`.
- `FraudAlert.save({ riskScore:10, status:'Pending', explanation: <SHAP bars> })`.
- 403 response back through trackeasy server to UI.

UI shows the **fraud-block modal** with:
- **Risk score**: 10 / 10
- **Why was this blocked?** (expandable list)
  - `[R2] Multiple failed payment attempts (+4)`
  - `[R3] Fast checkout after login (+3)`
  - `[R4] Historical quantity anomaly (+7)`
  - `[R6] Deep Learning: Abnormal sequence detected (Prob: 94%) (+5)`
  - `[R7] GNN: Highly connected to known fraud cluster (Risk: 91%) (+6)`
  - `[R8] Deep Learning: Unsupervised anomaly detected (Error: 6.80) (+4)`
  - `[R9] Behavioral Biometrics: Advanced Bot Behavior detected (89%) (+9)`
- **What contributed most?** (SHAP-style horizontal bars)

The customer is blocked from placing further orders for `FRAUD_BLOCK_COOLDOWN_MS` ms (default 10 min in `docker-compose.yml`). Login still works — the block only scopes order placement, see [`server/routes/orders.js`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/server/routes/orders.js) `enforceOrderBlock`.

Admin "Blocked Users" page picks up the user within 5 s (auto-refresh) and shows the unblock action.

---

## 6. What each model uniquely contributes

| Model | What it catches that nothing else does |
|---|---|
| **LSTM** | Bot **patterns** in event sequences — repeated `payment_failed`, fast `add_to_cart` loops. The rule engine only counts; the LSTM (in principle) sees order. |
| **GNN** | **Ring fraud** — accounts that look fine in isolation but share a phone/address/device with already-flagged accounts. |
| **Autoencoder** | **Novel anomalies** — transactions whose *combination* of (amount, items, hour, day) doesn't look like any past legit order. Doesn't need labels. |
| **ANN Master Brain** | The **calibration step** — combines all signals into one number that's actually meaningful and can escalate to OTP even when no single rule says "block". |
| **XAI** | The **why** — gives a per-feature attribution so the customer-facing block screen and admin alerts can explain themselves. |

---

## 7. Weaknesses still on the board

These are documented in detail in [`TODO.md`](../../TODO.md) but flagged here for context when reading the worked examples:

| ID | Issue | Affected docs |
|---|---|---|
| C1 | LSTM trained on only 3 unique sequences → behaves as template matcher | [LSTM.md](LSTM.md) |
| C2 | GNN graph is static; new users always score 0 | [GNN.md](GNN.md) |
| C3 | AE trained on synthetic `normal_transactions.csv` — calibration approximate | [Autoencoder.md](Autoencoder.md) |
| C4 | Master ANN trained on synthetic `ann_master_dataset.csv` | [ANN_Master_Brain.md](ANN_Master_Brain.md) |
| B3 | Master Brain can escalate but never reduce a rule-driven block | [ANN_Master_Brain.md](ANN_Master_Brain.md) |
| D1 | GNN false-positive on legitimate shared-device families | [GNN.md](GNN.md) |
| D2 | `clusterSize` always passes as `1` → unused dimension in master ANN | [ANN_Master_Brain.md](ANN_Master_Brain.md) |

---

## 8. How to reproduce the trace yourself

1. `cd "Jiya project/TrackEasy-3.O/TrackEasy" && docker compose up --build`
2. Sign up a customer in the UI.
3. Open the admin dashboard → **Inference Playground**.
4. Pick the customer, set `items`, `quantity`, `hour`, `day`, `paymentMethod`, click **Run**.
5. Observe the per-rule and per-model breakdown (this is exactly the same code path as Stage 3 above, surfaced for reading).

For surgical testing of individual models, hit the ML service directly on `http://localhost:8000/<endpoint>` (see the per-model docs for the curl invocations).
