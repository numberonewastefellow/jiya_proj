# Autoencoder — Unsupervised Anomaly Detection

A trained encoder–decoder MLP whose job is "reproduce the input". It was trained **only on legitimate transactions**, so when a strange-looking transaction arrives, the model can't reconstruct it well — the **reconstruction error (MSE)** spikes.

> **Trained model.** Weights live in [`fraud-service/ml/autoencoder_model.h5`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/autoencoder_model.h5) plus the matching feature scaler at [`scaler.joblib`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/scaler.joblib). Reproduce via [`train_autoencoder.py`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_autoencoder.py).

---

## 1. Purpose

Catch **transactions that look unlike anything the system has seen before** — without needing labelled fraud examples.

This is the only **unsupervised** model in the pipeline. Where the LSTM and ANN learn from "normal vs fraud" pairs, the autoencoder only learns "normal" and treats everything else as anomalous. That makes it the natural backstop for fraud patterns that don't match any known rule, e.g. an unusually large amount placed at 3 AM with many items.

---

## 2. Architecture (bottleneck autoencoder)

From [`train_autoencoder.py:33-46`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_autoencoder.py#L33-L46):

```
Input (4)          ← [amount, items, hour, day]   (after StandardScaler)
   │
Dense(8, relu)
   │
Dense(2, relu)     ← BOTTLENECK — forces the model to "summarise"
   │
Dense(8, relu)
   │
Dense(4, linear)   ← reconstruction
```

| | |
|---|---|
| **Input** | 4-D vector `[amount, items, hour, day]` |
| **Pre-processing** | `StandardScaler.transform(X)` → zero-mean unit-variance per feature |
| **Output** | 4-D reconstructed vector |
| **Loss** | `mean_squared_error` |
| **Training data** | [`normal_transactions.csv`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/normal_transactions.csv) — *only* legit rows, no labels |
| **Inference metric** | `MSE = mean((scaled - reconstructed)²)` |

---

## 3. Pre-processing pipeline (production path)

[fraudServer.js:255-273](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L255-L273) → [ml_service.py:149-165](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L149-L165):

```
Node side:
1. amount = transactionDetails.totalAmount    // ⚠ used to be .totalSum (bug)
2. items  = transactionDetails.items.length
3. hour   = new Date().getHours()             // 0–23
4. day    = new Date().getDay()               // 0–6 (Sun–Sat)
5. POST /predict/anomaly { transaction: { amount, items, hour, day } }

Python side:
6. X = np.array([[amount, items, hour, day]])
7. scaled = scaler.transform(X)
8. pred   = autoencoder.predict(scaled)
9. mse    = mean((scaled - pred) ** 2)
10. is_anomaly = mse > 2.5     ← threshold lives in ml_service.py:160
```

> 🐛 **Historical bug.** The Node side previously used `transactionDetails.totalSum`, which is undefined in this codebase. Every transaction looked like `amount = 0` to the autoencoder. Fixed at [`fraudServer.js:259`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L259) — kept the `totalSum` fallback for any old caller.

---

## 4. Output → score contribution

```js
// fraudServer.js:269-273
if (autoResult.is_anomaly) {
    riskScore += 4;
    violationReasons.push(`Deep Learning: Unsupervised anomaly detected (Error: ${autoResult.mse.toFixed(2)})`);
}
```

| | |
|---|---|
| **Threshold** | `mse > 2.5` ([ml_service.py:160](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L160)) |
| **Contribution** | `+4` to `riskScore` |
| **Returns** | `{ mse: float, is_anomaly: bool, threshold: 2.5 }` |

---

## 5. Worked examples

All MSE values below are illustrative — exact numbers depend on the trained weights and `normal_transactions.csv` distribution. The point is to show which side of the 2.5 threshold each falls on.

### ✅ Allowed — typical mid-day grocery order

| Input | Scaled (approx) | MSE | Action |
|---|---|---|---|
| `amount=899, items=3, hour=14, day=2` | near origin | **≈ 0.05** | does not fire |

### ✅ Allowed — late-night small order

| Input | MSE | Action |
|---|---|---|
| `amount=499, items=1, hour=23, day=5` | ≈ 0.4 | does not fire (still < 2.5) |

### 🚫 Blocked — high-value middle-of-the-night order

| Input | MSE | Action |
|---|---|---|
| `amount=87000, items=42, hour=3, day=0` | **≈ 6.8** | **fires → +4** |

### 🚫 Blocked — extreme bulk

| Input | MSE | Action |
|---|---|---|
| `amount=350000, items=120, hour=14, day=2` | ≈ 9.4 | **fires → +4** |

### ⚠ Edge case — every feature normal except `hour`

| Input | MSE | Action |
|---|---|---|
| `amount=599, items=2, hour=4, day=2` | ≈ 1.2 | does not fire (`hour` alone rarely pushes past threshold) |

The autoencoder is most useful when **multiple features deviate together**. A single anomalous feature (e.g. just an unusual hour) typically reconstructs fine because the other 3 features carry enough signal.

---

## 6. How to test it yourself

```bash
curl -X POST http://localhost:8000/predict/anomaly \
  -H 'Content-Type: application/json' \
  -d '{"transaction":{"amount":87000,"items":42,"hour":3,"day":0}}'
# → {"mse": 6.81, "is_anomaly": true, "threshold": 2.5}
```

Or use the Inference Playground in admin and tweak `amount`/`items`/`hour`/`day` to watch the MSE move.

---

## 7. Cross-references

- The rule that triggers AE: R8 in [fraudServer.js:255-273](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L255-L273)
- Final ensemble that consumes `autoMSE`: [`docs/models/ANN_Master_Brain.md`](ANN_Master_Brain.md)
- Top-level pipeline overview: [`PIPELINE.md`](../../PIPELINE.md)
- Backlog: TODO #C3 ("retrain on a richer normal-transaction set; current `normal_transactions.csv` is synthetic")
