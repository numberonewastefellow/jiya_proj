# GNN — Graph Neural Network for Fraud Rings

A trained Graph Convolutional Network that scores **each user node in a known fraud graph** for how "fraud-ring-like" their neighbourhood looks. The runtime call is a single-shot inference over a precomputed adjacency matrix — no graph is built per request.

> **Trained model.** Weights live in [`fraud-service/ml/gnn_model.h5`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/gnn_model.h5) plus three companion files: [`node_map.json`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/node_map.json), [`graph_nodes.csv`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/graph_nodes.csv), [`graph_edges.csv`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/graph_edges.csv). Reproduce via [`train_gnn.py`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_gnn.py).

---

## 1. Purpose

Catch **fraud rings** — groups of accounts that share a phone, address, or device fingerprint with already-flagged accounts. A single account can look perfectly normal on its own; what gives it away is **who it's connected to**.

Where the rule R8 in fraud-service tries to detect this with a hand-coded "shared-device" check, the GNN learns the pattern from labelled training graph data and can pick up indirect connections (friend-of-a-friend in a ring).

> ⚠️ **Static graph.** `node_map.json` is built once at training time. New customers who weren't in the graph at training time always score **0** — the endpoint short-circuits with `"reason": "Not in graph"`. Fixing this requires a periodic graph-rebuild job (TODO #C2).

---

## 2. Architecture

From [`train_gnn.py:55-69`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_gnn.py):

```
features (N, 2)        adjacency (N, N, normalised)
        \                /
         GCNLayer(32, relu)
                │
            Dropout(0.2)
                │
         GCNLayer(16, relu)
                │
         Dense(1, sigmoid)        ← N probabilities, one per node
```

`GCNLayer` is a custom Keras layer ([train_gnn.py:14-28](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/train_gnn.py#L14-L28)):

```python
def call(self, inputs):
    x, a = inputs
    x = tf.matmul(a, x)         # propagate features along edges
    x = tf.matmul(x, self.w)    # learnable transform
    return self.activation(x)
```

Adjacency matrix `A` is symmetrically normalised: `D⁻¹ᐟ² · A · D⁻¹ᐟ²`. Self-loops are added before normalisation.

| | |
|---|---|
| **Per-node features** | `[f1, f2]` from `graph_nodes.csv` (synthetic in this build — see TODO #C2) |
| **Edges** | `[source, target]` rows in `graph_edges.csv`; undirected |
| **Output** | one sigmoid probability per node |
| **Loss** | `binary_crossentropy`, with **Precision** as a co-metric to discourage false positives |

---

## 3. Pre-processing pipeline

The GNN is unique in that **almost all the work happens at startup**, not per-request.

### Startup ([ml_service.py:62-82](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L62-L82))

1. Load `gnn_model.h5` (with custom `GCNLayer`).
2. Load `node_map.json` → `{ userId: index }`.
3. Load `graph_nodes.csv` and `graph_edges.csv`.
4. Build **N × N** adjacency matrix `A` with self-loops.
5. Walk every edge → flip `A[i,j] = A[j,i] = 1`.
6. Normalise: `D⁻¹ᐟ² · A · D⁻¹ᐟ²`.
7. Stash features `X = nodes_df[['f1', 'f2']]` and `adj_norm` in `gnn_context`.

### Per-request ([ml_service.py:135-147](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/ml/ml_service.py#L135-L147))

```python
if userId not in node_map:
    return { probability: 0.0, reason: "Not in graph" }

idx = node_map[userId]
preds = model.predict([X, adj_norm])      # full forward pass over all nodes
return { probability: preds[idx][0] }
```

There is **no per-request graph manipulation** — it's a O(1) lookup into a precomputed prediction tensor (well, O(N²) in `model.predict`, but constant w.r.t. request payload).

---

## 4. Output → score contribution

```js
// fraudServer.js:243-250
const response = await axios.post(`${ML_SERVICE_URL}/predict/ring`, { userId });
const gnnResult = response.data;
if (gnnResult.probability > 0.85) {
    riskScore += 6;
    violationReasons.push(`Graph Neural Network: Highly connected to known fraud cluster (...)`);
}
```

| | |
|---|---|
| **Threshold** | `probability > 0.85` |
| **Contribution** | `+6` to `riskScore` |
| **Always 0 for** | users not in `node_map.json` |

---

## 5. Worked examples

### ✅ Allowed — brand-new customer (most realistic case)

| User in `node_map.json`? | Probability | Action |
|---|---|---|
| **No** | `0.0` (with `reason: "Not in graph"`) | does not fire — the GNN is dormant for new signups in this build |

This is by far the most common case in the demo flow because the seeded graph only contains a handful of user IDs.

### 🚫 Disallowed — node X strongly connected to flagged peers

Illustrative — exact value depends on the trained weights:

| User node | Neighbours flagged in training | Probability | Action |
|---|---|---|---|
| `userX` (idx 4) | 3 of 4 neighbours had `isBlocked=1` at training | **≈ 0.92** | **fires → +6** |
| `userY` (idx 7) | 1 of 6 neighbours flagged | ≈ 0.18 | does not fire |
| `userZ` (idx 11) | 0 flagged neighbours | ≈ 0.05 | does not fire |

### ⚠ Confused case — legitimate family on shared device

The graph builder in [`fraudServer.js:822-856`](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L822-L856) creates a "Same Device" edge between any two users who logged in from the same device fingerprint. A husband and wife on one home laptop become an edge in the graph. If one of them gets flagged for an unrelated reason at training time, the other inherits suspicion at inference time.

This is a real false-positive class and is documented as TODO #D1 ("review GNN edges before bulk-blocking").

---

## 6. How to test it yourself

```bash
# Start the stack:
cd "Jiya project/TrackEasy-3.O/TrackEasy"
docker compose up --build

# Direct call:
curl -X POST http://localhost:8000/predict/ring \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user_4"}'
# → {"probability": 0.92...}
#   or {"probability": 0.0, "reason": "Not in graph"}
```

The Inference Playground (admin dashboard → "Inference Playground") shows GNN input/output for any selected user, which is the easiest way to see "Not in graph" in action.

---

## 7. Cross-references

- The rule that triggers GNN: R7 in [fraudServer.js:241-253](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L241-L253)
- Graph-data viewer (admin "Fraud Ring" page) — built without the GNN, just from raw shared phone/address/device — at [fraudServer.js:776-863](../../Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js#L776-L863)
- Final ensemble that consumes `gnnProb`: [`docs/models/ANN_Master_Brain.md`](ANN_Master_Brain.md)
- Backlog: TODO #C2 (rebuild graph), TODO #D1 (false-positive review)
