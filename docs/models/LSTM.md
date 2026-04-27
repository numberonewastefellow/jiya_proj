# LSTM — Behavioural Sequence Model

A trained recurrent network that looks at the **last 10 events** a user produced (logins, add-to-cart, payment outcomes, ...) and outputs **one probability** that this sequence looks like fraud.

> **Trained model.** Weights live in [`fraud-service/ml/behavior_model.h5`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/behavior_model.h5). Reproduce via [`train_lstm.py`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_lstm.py). Interactive playground at [`test_lstm.ipynb`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/test_lstm.ipynb).

---

## 1. Purpose

Catch **bot-like activity patterns** that are hard to express as a simple count rule:

- Repeated `payment_failed` bursts (carding / card-checking bots).
- Rapid-fire `add_to_cart` loops with no checkout (scrapers).
- "Login → checkout" with nothing in between (replay attacks).

A naive rule like "≥ 2 payment_failed → flag" already exists (R2 in [fraudServer.js](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js)). The LSTM's job is to add the **temporal pattern** dimension — same events in different orders should ideally score differently.

> ⚠️ **Known limitation.** The shipped `behavior_model.h5` was trained on only 3 unique sequences (cf. notebook section 2). In practice it behaves more like a **template matcher** than a true sequence learner. See [`docs/models/WORKFLOW.md`](WORKFLOW.md#weaknesses-still-on-the-board) and TODO #C1 for the fix plan.

---

## 2. Architecture

From [`train_lstm.py:34-39`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_lstm.py):

```
Input(shape=(10, 1))
   │
LSTM(64, return_sequences=False)
   │
Dropout(0.3)
   │
Dense(32, relu)
   │
Dense(1, sigmoid)        ← single probability ∈ [0, 1]
```

| | |
|---|---|
| **Input shape** | `(batch, 10, 1)` — 10 time-steps × 1 integer feature per step |
| **Output** | `probability ∈ [0, 1]` (fraud confidence) |
| **Loss** | `binary_crossentropy` |
| **Class weights** | computed via `sklearn.utils.class_weight` (balanced) |
| **Callbacks** | `EarlyStopping(monitor='val_loss', patience=3)` |

---

## 3. Event vocabulary

Every event is mapped to an integer before going into the model. The mapping is duplicated in two places — keep them in sync:

| ID | Event | Where defined |
|----|-------|---------------|
| 0 | *(padding)* | implicit |
| 1 | `login` | [`fraudServer.js:208`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L208) |
| 2 | `add_to_cart` | same |
| 3 | `remove_from_cart` | same |
| 4 | `checkout_attempt` | same |
| 5 | `payment_failed` | same |
| 6 | `payment_success` | same |

---

## 4. Pre-processing pipeline (production path)

The Node side ([fraudServer.js:216-228](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L216-L228)) does the gather + map; the Python side ([ml_service.py:122-133](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L122-L133)) does the pad + reshape:

```
1. Mongo:   EventLog.find({ userId }).sort({ timestamp: -1 }).limit(20)
2. Node:    take .slice(0, 10)
3. Node:    map eventType → integer via EVENT_MAP
4. Node:    .reverse() → chronological order
5. Node →   POST /predict/behavioral { sequence: [...] }
6. Python:  if len(seq) < 10:  pad with zeros at the FRONT
7. Python:  reshape (1, 10, 1)
8. Python:  model.predict → probability
```

Step 6 matters: a brand-new user with only `[1, 2]` (login → add) gets fed in as `[0,0,0,0,0,0,0,0,1,2]`. The model has never seen sequences with leading zeros during training, so cold-start outputs are **unstable** (typically 0.10 – 0.40 — see notebook cell 6).

---

## 5. Output → score contribution

```js
// fraudServer.js:231-235
if (result.probability > 0.85) {
    riskScore += 5;
    violationReasons.push(`Deep Learning: Abnormal behavioral sequence detected (Prob: ...)`);
}
```

| | |
|---|---|
| **Threshold** | `probability > 0.85` |
| **Contribution** | `+5` to `riskScore` (out of cap 10) |
| **Skipped if** | fewer than 5 events in the user's recent log |

---

## 6. Worked examples

All numbers below were measured against the shipped `behavior_model.h5` in the test notebook unless flagged "illustrative".

### ✅ Allowed — normal shopping

| Sequence | Decoded | Probability | Action |
|---|---|---|---|
| `[1, 2, 2, 3, 2, 4, 6, 2, 2, 2]` | login → 3 adds → remove → add → checkout → success → 3 adds | **≈ 0.001** | does not fire |

### ✅ Allowed — realistic shopper not in training

| Sequence | Decoded | Probability | Action |
|---|---|---|---|
| `[1, 2, 3, 2, 2, 3, 2, 4, 6, 2]` | picky shopper, multiple add/remove | ≈ 0.20 – 0.45 | does not fire |
| `[1, 2, 2, 4, 5, 4, 6, 2, 2, 2]` | failed once, retried, succeeded | ≈ 0.10 – 0.35 | does not fire |

### 🚫 Blocked — repeated payment failures (matches a training template)

| Sequence | Decoded | Probability | Action |
|---|---|---|---|
| `[5, 5, 5, 5, 5, 5, 5, 5, 5, 5]` | 10× `payment_failed` | **≈ 0.99** | **fires → +5** |

### 🚫 Blocked — rapid bot-style adds (matches a training template)

| Sequence | Decoded | Probability | Action |
|---|---|---|---|
| `[2, 2, 2, 2, 2, 2, 2, 2, 2, 2]` | 10× `add_to_cart`, no checkout | **≈ 0.99** | **fires → +5** |

### ⚠ Cold-start — unstable

| Sequence (after zero-pad) | Decoded | Probability | Note |
|---|---|---|---|
| `[0,0,0,0,0,0,0,0,0,1]` (`[1]`) | just logged in | ≈ 0.10 – 0.30 | does not fire |
| `[0,0,0,0,0,0,0,0,1,2]` (`[1,2]`) | login + 1 add | ≈ 0.20 – 0.45 | does not fire |
| `[0,0,0,0,1,2,2,4,5,5]` (`[1,2,2,4,5,5]`) | 6 events, two failures | ≈ 0.5 – 0.8 | borderline; see notebook cell 6 |

### Order-sensitivity — does the LSTM actually use sequence?

Both rows have **5 add_to_cart + 5 payment_failed**, just in different orders:

| Sequence | Probability | Comment |
|---|---|---|
| `[5, 5, 5, 5, 5, 2, 2, 2, 2, 2]` | ≈ 0.97 | failures-then-adds |
| `[2, 2, 2, 2, 2, 5, 5, 5, 5, 5]` | ≈ 0.96 | adds-then-failures |
| `[5, 2, 5, 2, 5, 2, 5, 2, 5, 2]` | ≈ 0.95 | strict alternating |

The probabilities are **almost identical**, which tells us the trained model is essentially counting `5`s rather than modelling temporal order. This is documented as a model-quality concern in TODO #C1.

---

## 7. How to test it yourself

```bash
cd "Jiya project/TrackEasy-3.O/TrackEasy"
docker compose -f docker-compose.train.yml up --build      # opens Jupyter on http://localhost:8888
```

Open `fraud-service/ml/test_lstm.ipynb`. The notebook walks through the same examples above plus a 2-D probability surface (cell 10).

Or call the live endpoint directly:

```bash
curl -X POST http://localhost:8000/predict/behavioral \
  -H 'Content-Type: application/json' \
  -d '{"sequence":[5,5,5,5,5,5,5,5,5,5]}'
# → {"probability": 0.99...}
```

---

## 8. Cross-references

- End-to-end pipeline: [`docs/models/WORKFLOW.md`](WORKFLOW.md)
- Final ensemble that consumes `lstmProb`: [`docs/models/ANN_Master_Brain.md`](ANN_Master_Brain.md)
- Top-level overview of all 11 rules: [`PIPELINE.md`](../../PIPELINE.md)
- Backlog item to fix template-matching behaviour: TODO #C1 in [`TODO.md`](../../TODO.md)
