# TrackEasy-3.O — Services & URLs

Multi-service fraud-detection stack orchestrated via [docker-compose.yml](docker-compose.yml). Five services share a single Docker network; only four expose ports on the host.

## Quick Start

```bash
# from this folder (TrackEasy/)
docker compose up -d              # build & start all services
docker compose logs -f jupyter    # tail a specific service
docker compose down               # stop everything (keeps mongo_data volume)
```

Start a single service only:
```bash
docker compose up -d jupyter      # just the notebook environment
docker compose up -d mongo trackeasy   # web app + DB only
```

## First-Time Setup — Seeded Demo Data

On the very first boot (when the `users` collection is empty), `trackeasy` auto-seeds a demo dataset from [`server/seed/*.csv`](server/seed/) so you can log in and click around immediately. Subsequent boots find existing users and skip the seed entirely — no risk of clobbering data.

**Seeded accounts** — all passwords are `password123` (demo-only; change for any non-local deployment):

| Email | Role |
| --- | --- |
| `admin@trackeasy.com` | admin |
| `manager1@trackeasy.com` | manager |
| `vendor.fresh@trackeasy.com` | vendor (groceries) |
| `vendor.tech@trackeasy.com` | vendor (electronics) |
| `customer.alice@trackeasy.com` | customer |
| `customer.bob@trackeasy.com` | customer |
| `customer.eve@trackeasy.com` | customer (fraud-prone in demo) |

**Also seeded**:
- **10 products** with real `picsum.photos` images (5 groceries + 5 electronics)
- **7 demo orders** across customers (mix of Delivered, On Board, Pending, Rejected)
- **3 fraud-alert records** to populate the admin dashboard immediately
- **5 EventLog rows** — Mumbai login history for alice, Bangalore for bob

The Mumbai history primes the **geo-anomaly demo** — log in as `customer.alice@trackeasy.com / password123`, add an item, flip the cart-page "Ordering from" picker to "🗽 New York", click Proceed → the OTP modal fires immediately with reason *"Order placed from a new location — New York, US (≈12 500 km from your usual area: Mumbai)"*.

### Manual seed commands

```bash
# Idempotent upsert — safe to re-run; updates existing rows, inserts new ones:
docker compose exec trackeasy npm run seed

# DESTRUCTIVE — wipes Users + Products + Orders + FraudAlerts + EventLog, then reseeds:
docker compose exec trackeasy npm run seed:reset
```

After editing any of the `server/seed/*.csv` files, run `npm run seed` to push changes into the DB.

### Admin UI

Once you're logged in as `admin@trackeasy.com / password123`, the admin dashboard has a **Demo Data** tab in the sidebar with two buttons:

- **🌱 Run reseed** — `POST /api/admin/seed`, idempotent upsert
- **⚠️ Reset & reseed** — `POST /api/admin/seed/reset`, destructive; logs you out so you can sign back in against the fresh admin row

Both endpoints require an admin JWT; non-admin callers get `403`.

### Disable auto-seed

For production or CI, set `SKIP_AUTO_SEED=true` in the `trackeasy` service env. The server then never seeds, even on an empty DB.

## Services

| Service | Host URL | Container Port | Image / Build | Purpose |
| --- | --- | :---: | --- | --- |
| **trackeasy** | http://localhost:5000 | 5000 | [`server/Dockerfile`](server/Dockerfile) (Node 20) | Main web app — auth UI, dashboard, user-facing endpoints |
| **fraud-service** | http://localhost:5002 | 5002 | [`fraud-service/Dockerfile`](fraud-service/Dockerfile) (Node 20) | Fraud-scoring orchestrator — applies rules + forwards to ml-service |
| **ml-service** | http://localhost:8000 | 8000 | [`fraud-service/ml/Dockerfile`](fraud-service/ml/Dockerfile) (Python 3.11 + TensorFlow) | FastAPI model-serving — LSTM / GNN / Autoencoder / ANN / XGBoost / RF / IF inference |
| **jupyter** | http://localhost:8888 | 8888 | [`Dockerfile.jupyter`](Dockerfile.jupyter) (Python 3.11) | JupyterLab/Notebook — `fraud_detection_notebook (1).ipynb` training env |
| **mongo** | *(internal only)* | 27017 | `mongo:7` | Database — persisted in `mongo_data` named volume |

## Key Endpoints

### trackeasy — http://localhost:5000
- `GET  /` — Login / signup UI
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET  /api/auth/verify` (Bearer token)
- Dashboard (protected)

See [`server/README.md`](server/README.md) for full auth-API details.

### fraud-service — http://localhost:5002
- Internal scoring orchestrator called by `trackeasy`; forwards requests to `ml-service` and applies rule-based checks (Superman travel-speed, velocity spikes).
- Source: [`fraud-service/fraudServer.js`](fraud-service/fraudServer.js).

### ml-service — http://localhost:8000
- **Swagger UI:** http://localhost:8000/docs
- FastAPI application defined in [`fraud-service/ml/ml_service.py`](fraud-service/ml/ml_service.py)
- Serves the trained artifacts in [`fraud-service/ml/`](fraud-service/ml/): `ann_fraud_brain.h5`, `behavior_model.h5` (LSTM), `gnn_model.h5`, `autoencoder_model.h5`, `rf_model.joblib`, `iso_forest_model.joblib`, `xgb_model.json`.

### jupyter — http://localhost:8888
- No token required (dev-convenient; do not expose port publicly).
- `/workspace` inside the container is bind-mounted to the [Jiya project folder](../..) on the host, so you can see:
  - `/workspace/fraud_detection_notebook (1).ipynb`
  - `/workspace/Fraudulent_E-Commerce_Transaction_Data_2.csv`
  - `/workspace/transactions.csv`
  - `/workspace/creditcard.csv`
  - `/workspace/TrackEasy-3.O/TrackEasy_Fraud_ML_Training.ipynb`
  - `/workspace/improvements_over_paper.md`
- Installed packages: `notebook`, `jupyterlab`, `pandas`, `numpy`, `matplotlib`, `seaborn`, `scikit-learn`, `xgboost`, `imbalanced-learn`, `joblib`.
- Changes persist to your local disk (bind mount), including saved models under `saved_models/`.

## Internal Network

Services reach each other by service name on the default compose network — **do not** use `localhost` inside a container. Relevant cross-service URLs (set as env vars in compose):

| From | To | URL inside Docker |
| --- | --- | --- |
| `trackeasy` | `fraud-service` | `http://fraud-service:5002` (`FRAUD_SERVICE_URL`) |
| `trackeasy` | `mongo` | `mongodb://mongo:27017/trackeasy` (`MONGODB_URI`) |
| `fraud-service` | `ml-service` | `http://ml-service:8000` (`ML_SERVICE_URL`) |
| `fraud-service` | `mongo` | `mongodb://mongo:27017/trackeasy` (`MONGODB_URI`) |

## Startup Order

`mongo` and `ml-service` have healthchecks. Dependents wait:

```
mongo (healthy) ────┐
                    ├──> fraud-service ──> trackeasy
ml-service (up) ────┘
jupyter             (independent)
```

## Environment Variables

Baked into [docker-compose.yml](docker-compose.yml); override by editing compose or creating a `.env` alongside it.

| Service | Variable | Default | Note |
| --- | --- | --- | --- |
| trackeasy | `PORT` | `5000` | |
| trackeasy | `MONGODB_URI` | `mongodb://mongo:27017/trackeasy` | |
| trackeasy | `FRAUD_SERVICE_URL` | `http://fraud-service:5002` | |
| trackeasy | `JWT_SECRET` | `devsecret_change_in_production` | **change for production** |
| fraud-service | `PORT` | `5002` | |
| fraud-service | `MONGODB_URI` | `mongodb://mongo:27017/trackeasy` | |
| fraud-service | `ML_SERVICE_URL` | `http://ml-service:8000` | |

## Volumes

- `mongo_data` — named volume, persists MongoDB data between `docker compose down/up`.
- `../..:/workspace` on `jupyter` — bind mount of the host `Jiya project/` folder.

## Healthchecks

- `mongo` — `mongosh ping` every 10 s (5 retries).
- `ml-service` — HTTP GET on `/docs` every 15 s (10 retries, 60 s start period).
- Others — none; inspect logs with `docker compose logs -f <service>`.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `jupyter` container exits immediately | Rebuild without cache: `docker compose build --no-cache jupyter` |
| Notebook XGBoost cells fail with `use_label_encoder` TypeError | XGBoost ≥ 2.0 removed that parameter — remove `use_label_encoder=False,` from each `XGBClassifier(...)` call |
| Can't reach http://localhost:8000/docs | `docker compose logs ml-service` — likely TensorFlow model-load error |
| Port already in use | Change the host-side port, e.g. `"18888:8888"`, then browse `http://localhost:18888` |
| Want to reset DB | `docker compose down -v` (destroys `mongo_data`) |
