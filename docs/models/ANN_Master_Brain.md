# ANN Master Brain — Final Ensemble + XAI

A small trained MLP that takes the **outputs of the rule engine and the other 3 models** and produces a single calibrated `final_fraud_probability`. It also drives the **explainability (XAI)** feature: a SHAP-style breakdown of which signal pushed the score up the most.

> **Trained model.** Weights live in [`fraud-service/ml/ann_fraud_brain.h5`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ann_fraud_brain.h5). Reproduce via [`train_ann.py`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_ann.py). XAI is its own endpoint, [`/predict/explain`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L210-L244).

---

## 1. Purpose

The pipeline produces a lot of signal: a hand-coded rule score, an LSTM probability, a GNN probability, an autoencoder MSE, plus a couple of physical features (geo-speed, cluster size). Hand-tuning weights on these would be brittle.

The Master Brain ANN learns the **right way to combine them** from labelled training data ([ann_master_dataset.csv](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ann_master_dataset.csv)). It can spot patterns like "rules are quiet, but LSTM and AE both spiked → probably fraud" that a single threshold can't.

The XAI sibling answers "**why** did the brain say 0.91?" — useful for the customer-facing block screen and for the admin alerts dashboard.

---

## 2. Architecture

From [`train_ann.py:27-32`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_ann.py#L27-L32):

```
Input(6)           ← [ruleScore, lstmProb, gnnProb, autoMSE, geoSpeed, clusterSize]
   │
Dense(16, relu)
   │
Dropout(0.1)
   │
Dense(8, relu)
   │
Dense(1, sigmoid)  ← final_fraud_probability ∈ [0, 1]
```

| | |
|---|---|
| **Input** | 6-D feature vector |
| **Output** | `probability ∈ [0, 1]` |
| **Loss** | `binary_crossentropy` |
| **Co-metric** | `Precision` (training optimises against false positives) |
| **Callbacks** | `EarlyStopping(monitor='val_loss', patience=5)` |

### The 6 input features (order matters!)

| # | Feature | Source | Typical range |
|---|---|---|---|
| 0 | `ruleScore` | sum of fired rules R1–R10 in fraudServer.js | 0 – 10 (often capped at 10 elsewhere) |
| 1 | `lstmProb` | [LSTM](LSTM.md) `/predict/behavioral` | 0 – 1 |
| 2 | `gnnProb` | [GNN](GNN.md) `/predict/ring` | 0 – 1 |
| 3 | `autoMSE` | [Autoencoder](Autoencoder.md) `/predict/anomaly` | 0 – ~10 |
| 4 | `geoSpeed` | km/h between last and current IP location | 0 – ~1500 |
| 5 | `clusterSize` | currently hardcoded to `1` in fraudServer.js | (unused at runtime — TODO #D2) |

Order is wired in [`ml_service.py:173`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L173) and must match `train_ann.py`.

---

## 3. How it's invoked

[fraudServer.js:322-348](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L322-L348):

```js
const brainResponse = await axios.post(`${ML_SERVICE_URL}/predict/master`, {
    ensemble_features: { ruleScore: riskScore, lstmProb, gnnProb, autoMSE, geoSpeed, clusterSize }
});
const brainProb = brainResponse.data.probability;

if (brainProb > 0.9) {
    action = 'requires_otp';                                // ← only escalates, never reduces
    violationReasons.push(`ANN Master Brain: Extremely high risk ensemble (...)`);
}
```

> ⚠️ **Asymmetry.** The brain can *escalate* a request to `requires_otp` but it cannot *reduce* the score that came from rules. So if rules already produced score 9 (→ block), the brain is a no-op even if `brainProb = 0.05`. Documented as TODO #B3.

After the brain returns, [fraudServer.js:358-380](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L358-L380) caps `riskScore` at 10 and runs the final action map:

| `riskScore` | `action` |
|---|---|
| `> 8` | **block** + auto-block user with cooldown (`FRAUD_BLOCK_COOLDOWN_MS`) |
| `> 6` | `requires_otp` |
| `> 3` | `warning` |
| else | `allow` |

…with the brain's `> 0.9` rule as a separate path that can also force `requires_otp`.

---

## 4. XAI — explainability via baseline perturbation

**Not a separate model.** The XAI endpoint reuses the same `ann_fraud_brain.h5` and answers "what would the prediction look like if feature *i* had its average value instead of its actual value?".

From [`ml_service.py:210-244`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L210-L244):

```python
features  = ['ruleScore', 'lstmProb', 'gnnProb', 'autoMSE', 'geoSpeed', 'clusterSize']
baselines = [2.5,         0.3,        0.3,       2.0,       300,        2          ]

full_prob = ann.predict(X)[0][0]
for i, name in enumerate(features):
    X_perturbed = X.copy()
    X_perturbed[0, i] = baselines[i]                # replace one feature with baseline
    perturbed_prob = ann.predict(X_perturbed)[0][0]
    contribution[i] = (full_prob - perturbed_prob) * 10   # scale to "score points"
```

| `contribution` value | Meaning |
|---|---|
| Large **positive** | this feature *pushed the prediction towards fraud* |
| Near **zero** | this feature was already near baseline / didn't matter |
| **Negative** | this feature actually *lowered* the fraud prediction |

The `× 10` scaling is so the contributions show up as comparable to the 0–10 risk score — they are **NOT** standard SHAP values; they are a single-feature ablation.

The result is rendered as horizontal bars in:
- The customer "Why was this blocked?" panel (after a fraud block).
- The admin "Inference Playground" view.
- The admin "Fraud Alerts" expandable row.

---

## 5. Worked examples

All `final_prob` values below are illustrative — they depend on the trained weights of the shipped `ann_fraud_brain.h5`. What's exact is the input vector and the qualitative outcome.

### ✅ Allowed — clean order

| Feature | Value |
|---|---|
| ruleScore | 0 |
| lstmProb | 0.04 |
| gnnProb | 0.0 (not in graph) |
| autoMSE | 0.05 |
| geoSpeed | 0 |
| clusterSize | 1 |

→ `final_prob ≈ 0.06` → **does not escalate** → action stays `allow`.

XAI top contributions: all near zero (everything is near baseline).

### ⚠ Warning — borderline

| Feature | Value |
|---|---|
| ruleScore | 4 (one velocity rule fired) |
| lstmProb | 0.55 |
| gnnProb | 0.0 |
| autoMSE | 1.4 |
| geoSpeed | 250 |
| clusterSize | 1 |

→ `final_prob ≈ 0.42` → **does not escalate**.
Action from rule path: `warning` (riskScore > 3).

XAI: `ruleScore +0.18`, `lstmProb +0.12`, others ~0.

### 🚫 Blocked — multi-signal fraud

| Feature | Value |
|---|---|
| ruleScore | 8 |
| lstmProb | 0.96 |
| gnnProb | 0.0 |
| autoMSE | 6.4 |
| geoSpeed | 0 |
| clusterSize | 1 |

→ `final_prob ≈ 0.97` → **escalates to `requires_otp`** (but rule path already says `block` because riskScore > 8, so block wins).

XAI top-3:
- `lstmProb` → +3.8 (biggest pusher)
- `ruleScore` → +2.6
- `autoMSE` → +1.4

### 🚫 Blocked — pure ensemble case (rules silent, models loud)

This is the case the brain exists for.

| Feature | Value |
|---|---|
| ruleScore | 2 (only "fast checkout" fired) |
| lstmProb | 0.94 |
| gnnProb | 0.91 (in known fraud cluster) |
| autoMSE | 5.1 |
| geoSpeed | 1200 |
| clusterSize | 1 |

→ Rule path on its own: `riskScore = 2` → would be `allow`.
But the GNN and LSTM thresholds *also* fire (each adds to riskScore: `+5` from LSTM, `+6` from GNN, `+4` from AE) before the brain is called, lifting riskScore to 10 (capped).
→ `final_prob ≈ 0.98` → escalates to OTP.
Final action: `block` (because riskScore > 8 wins over OTP).

XAI top-3: `gnnProb +3.5`, `lstmProb +3.0`, `autoMSE +1.6`.

---

## 6. How to test it yourself

```bash
# Direct master-brain call:
curl -X POST http://localhost:8000/predict/master \
  -H 'Content-Type: application/json' \
  -d '{"ensemble_features":{"ruleScore":8,"lstmProb":0.96,"gnnProb":0,"autoMSE":6.4}}'
# → {"probability": 0.97...}

# XAI call:
curl -X POST http://localhost:8000/predict/explain \
  -H 'Content-Type: application/json' \
  -d '{"ensemble_features":{"ruleScore":8,"lstmProb":0.96,"gnnProb":0,"autoMSE":6.4}}'
# → {"final_prob":0.97, "explanation":[{"feature":"ruleScore","contribution":2.6}, ...], "base_value":...}
```

The Inference Playground (admin → "Inference Playground") drives both endpoints together and renders the XAI bars.

---

## 7. Known limitations

- **Asymmetric escalation.** Rule-path block decisions cannot be reduced by a low brain probability. (TODO #B3)
- **`clusterSize` is a constant.** Always passed in as `1` from fraudServer.js — model has no real signal there. (TODO #D2)
- **Synthetic training data.** `ann_master_dataset.csv` is generated, not from real production cases. Calibration of `final_prob` is approximate. (TODO #C4)

---

## 8. Cross-references

- Inputs come from: [LSTM](LSTM.md) · [GNN](GNN.md) · [Autoencoder](Autoencoder.md) · 11 hand-coded rules in [fraudServer.js](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js)
- Where the action mapping lives: [fraudServer.js:358-380](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L358-L380)
- End-to-end pipeline: [`docs/models/WORKFLOW.md`](WORKFLOW.md)
