# Jiya — TrackEasy Fraud Detection Platform

An e-commerce order tracking platform (**TrackEasy**) with a multi-model fraud detection microservice, inspired by the IJACSA 2019 paper *"Fraud Detection using Machine Learning in e-Commerce"* (Saputra & Suharjito) and extended with modern deep learning + ensemble meta-learning.

> **📖 See also: [PIPELINE.md](PIPELINE.md)** — end-to-end walkthrough of the fraud detection pipeline (rule layer, ML models, ensemble, action mapping, worked examples).
>
> **🧠 Per-model deep-dives:** [LSTM](docs/models/LSTM.md) · [GNN](docs/models/GNN.md) · [Autoencoder](docs/models/Autoencoder.md) · [ANN Master Brain](docs/models/ANN_Master_Brain.md) · [End-to-end workflow](docs/models/WORKFLOW.md).

## What's inside

| Service | Tech | Port | Role |
|---|---|---|---|
| **trackeasy** | Node.js + Express + MongoDB | `5000` | E-commerce app: customer / vendor / manager / admin dashboards, orders, payments. Serves both API and frontend. |
| **fraud-service** | Node.js + Express | `5002` | Fraud orchestrator: rule checks (velocity, geo "Superman", biometrics, honeypot) + calls the ML service for specialist model scores. Exposed so browser dashboards can fetch alerts directly. |
| **ml-service** | Python + FastAPI + TensorFlow | `8000` | Serves 7 pre-trained models — LSTM (behavioral), GNN (fraud rings), Autoencoder (anomaly), ANN master brain, RF, XGBoost, Isolation Forest. |
| **mongo** | MongoDB 7 | internal | Shared datastore for users, orders, products, fraud alerts, event logs. |

## Architecture

```
                  ┌────────────────────┐
  Browser ────▶   │  trackeasy :5000   │ ── Mongo ──┐
  (dashboards)    │  (Express + HTML)  │            │
        │         └─────────┬──────────┘            │
        │                   │                       │
        │                   ▼ server→fraud calls    │
        │         ┌────────────────────┐            │
        └──────▶  │ fraud-service:5002 │ ──────────┤
   (browser JS    │  (rules + orch.)   │            │
    reads alerts) └─────────┬──────────┘            │
                            ▼                       │
                  ┌────────────────────┐            │
                  │  ml-service :8000  │            │
                  │  (FastAPI + TF)    │            │
                  └────────────────────┘            │
                                                    ▼
                                              ┌──────────┐
                                              │  mongo   │
                                              └──────────┘
```

## Quickstart — zero configuration

Requires Docker with the Compose plugin. From the repo root:

```bash
cd "Jiya project/TrackEasy-3.O/TrackEasy"
docker compose up --build
```

First build takes a few minutes (TensorFlow is heavy). Subsequent `docker compose up` runs start in seconds.

Once all four services report ready, open:

- **App:** http://localhost:5000
- **Fraud API:** http://localhost:5002/api/fraud/alerts
- **ML API docs:** http://localhost:8000/docs

No `.env` files, no DB seeding, no manual model training — everything ships in the images.

### Windows shortcut — `build.bat`

A small batch helper sits next to `docker-compose.yml` for the most common compose actions. Run it from any directory; it auto-cds to its own folder so paths-with-spaces don't bite.

```bat
build.bat help            REM Show all commands

REM Common build/start operations
build.bat up              REM Start all services in background
build.bat up-build        REM Rebuild + start everything
build.bat up-web          REM Rebuild + (re)start just trackeasy
build.bat up-fraud        REM Rebuild + (re)start just fraud-service
build.bat up-ml           REM Rebuild + (re)start just ml-service
build.bat build-all       REM Rebuild every image without starting

REM Stop / reset
build.bat down            REM Stop containers (keep DB volume)
build.bat reset           REM Stop AND wipe the mongo volume

REM Restart without rebuild
build.bat restart         REM All services
build.bat restart-web     REM trackeasy only
build.bat restart-fraud   REM fraud-service only
build.bat restart-ml      REM ml-service only

REM Diagnostics & data
build.bat logs            REM Tail all logs
build.bat logs-fraud      REM Tail one service
build.bat ps              REM Container status
build.bat seed            REM Run server/scripts/seed.js inside trackeasy
```

Linux/macOS users can keep using `docker compose ...` directly — the helper is Windows-only convenience.

## Demo data & credentials

The app boots with an empty MongoDB. You have two ways to get started:

### Option A — seed the demo dataset (recommended)

One command populates users, products, orders, and fraud alerts so every role has something to look at:

```bash
docker compose exec trackeasy node scripts/seed.js
```

You'll see per-table counts, linkage validation, and a final `All validations passed.` line. The seeder is **idempotent** — safe to re-run any time; edits to the CSVs propagate on the next run.

Then there is one more admin user to create. The signup form only exposes customer / vendor / manager roles, so the admin is created via a one-liner:

```bash
docker compose exec -T trackeasy node -e "
(async () => {
  const mongoose = require('mongoose');
  const bcrypt = require('bcryptjs');
  const User = require('./models/User');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://mongo:27017/trackeasy');
  const hash = await bcrypt.hash('admin123', 10);
  await User.findOneAndUpdate(
    { email: 'admin@trackeasy.com' },
    { username: 'system_admin', email: 'admin@trackeasy.com', password: hash, role: 'admin', phoneNumber: '1000000001' },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log('admin ready: admin@trackeasy.com / admin123');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
"
```

### Demo credentials

All accounts below use password **`password123`** unless noted.

| Role | Email | Password | Notes |
|---|---|---|---|
| admin | `admin@trackeasy.com` | `admin123` | Created via the one-liner above |
| manager | `manager1@trackeasy.com` | `password123` | |
| vendor (FreshMart — groceries) | `vendor.fresh@trackeasy.com` | `password123` | Owns 5 products |
| vendor (TechWorld — electronics) | `vendor.tech@trackeasy.com` | `password123` | Owns 5 products |
| customer | `customer.alice@trackeasy.com` | `password123` | Has 3 completed / in-progress orders |
| customer | `customer.bob@trackeasy.com` | `password123` | Has 2 orders, 1 fraud alert (Reviewed) |
| customer (risky profile) | `customer.eve@trackeasy.com` | `password123` | Has 2 flagged orders, 2 Pending fraud alerts |

### What the seed contains

Files live under [server/seed/](Jiya%20project/TrackEasy-3.O/TrackEasy/server/seed/) as plain CSV so you can edit and re-run:

| CSV | Rows | Supports use case |
|---|---|---|
| `users.csv` | 1 manager + 2 vendors + 3 customers | All |
| `products.csv` | 10 products across 2 vendors | **Vendor flow** — log in as a vendor, see and edit your catalog |
| `orders.csv` | 7 orders (Delivered / On Board / Pending / Rejected, all 3 payment methods) | **Customer flow** — log in as alice or bob, see order history |
| `fraud_alerts.csv` | 3 alerts (risk scores 4, 8, 9) with SHAP-like explanations | **Admin / manager flow** — log in as admin, see `/fraud-dashboard.html` populated |

The seeder is at [server/scripts/seed.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/scripts/seed.js). It:

1. Parses each CSV (RFC-4180 style — handles `""`-escaped quotes inside fields).
2. Hashes passwords with bcrypt before insert.
3. Resolves foreign keys (vendor email → ObjectId, customer email → ObjectId).
4. Upserts by natural key (`email` for users, `orderId` for orders, `transactionId` for alerts, `name + vendor` for products).
5. Validates: counts totals, confirms linkage, verifies a seeded password hash actually authenticates.
6. Exits non-zero on any validation failure.

### Option B — sign up manually

If you'd rather start clean, just visit http://localhost:5000 and use the signup form (roles: customer / vendor / manager). Skip the seed command. Admin still needs the one-liner.

## First-time tour (after seeding)

1. Log in as **`vendor.fresh@trackeasy.com`** → you'll see the FreshMart products and any pending customer orders to fulfil.
2. Log in as **`customer.alice@trackeasy.com`** → see her 3 orders, try placing a new one.
3. Try placing a **huge-quantity order** as `customer.eve@trackeasy.com` — the fraud service will score it; watch `docker compose logs -f fraud-service` to see each model fire.
4. Log in as **`admin@trackeasy.com`** → open `/fraud-dashboard.html` to review the 3 pre-seeded alerts plus whatever new ones you just generated.

## Stop & reset

```bash
docker compose down          # stop, keep data
docker compose down -v       # stop and wipe MongoDB volume
```

## Repo layout

```
.
├── Jiya project/
│   ├── TrackEasy-3.O/
│   │   ├── TrackEasy/
│   │   │   ├── docker-compose.yml       ← run from here
│   │   │   ├── server/                  (Node app + frontend)
│   │   │   ├── fraud-service/           (Node orchestrator)
│   │   │   │   └── ml/                  (Python FastAPI + trained models)
│   │   │   └── tech.md
│   │   ├── TrackEasy_Fraud_ML_Training.ipynb
│   │   └── fraud_model_explanation.md
│   ├── Fraudulent_E-Commerce_Transaction_Data_2.csv
│   ├── Paper_43-Fraud_Detection_using_Machine_Learning_in_E_Commerce.pdf
│   ├── fraud_detection_notebook (1).ipynb
│   └── transactions.csv
├── paper.txt                            (reference paper, plain text)
└── README.md
```

## Environment variables (auto-set by docker compose)

You don't need to set any of these manually — compose injects them. They're documented only so you know what the services read.

### `trackeasy`

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | HTTP port |
| `MONGODB_URI` | `mongodb://mongo:27017/trackeasy` | Mongo connection |
| `FRAUD_SERVICE_URL` | `http://fraud-service:5002` | Where server-side code calls the fraud service |
| `JWT_SECRET` | `devsecret_change_in_production` | Auth signing key — **change for any non-local use** |

### `fraud-service`

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `5002` | HTTP port |
| `MONGODB_URI` | `mongodb://mongo:27017/trackeasy` | Shared Mongo |
| `ML_SERVICE_URL` | `http://ml-service:8000` | Where it calls the Python model server |

### `ml-service`

No configuration required. Models load from disk at container start.

## CORS

Both Node services use permissive `cors()` middleware — browser-side JS running on `http://localhost:5000` is free to call `http://localhost:5002/api/fraud/*` directly (which the dashboards do). If you deploy behind different hostnames, tighten the CORS origin list in [server/server.js](Jiya%20project/TrackEasy-3.O/TrackEasy/server/server.js) and [fraud-service/fraudServer.js](Jiya%20project/TrackEasy-3.O/TrackEasy/fraud-service/fraudServer.js).

## Developing outside Docker

Each service still works standalone:

```bash
# trackeasy
cd "Jiya project/TrackEasy-3.O/TrackEasy/server"
npm install
MONGODB_URI=mongodb://localhost:27017/trackeasy JWT_SECRET=dev npm start

# fraud-service
cd "Jiya project/TrackEasy-3.O/TrackEasy/fraud-service"
npm install
MONGODB_URI=mongodb://localhost:27017/trackeasy npm start

# ml-service
cd "Jiya project/TrackEasy-3.O/TrackEasy/fraud-service/ml"
pip install -r requirements.txt
uvicorn ml_service:app --host 0.0.0.0 --port 8000
```

You'll need a local MongoDB running on `localhost:27017`.

## Notes

- `JWT_SECRET` defaults to a dev placeholder — change it before any real deployment.
- `creditcard.csv` (~150 MB) is git-ignored; drop it into `Jiya project/` manually if you want to re-run the exploratory notebook.
- This is a capstone / learning project. There's no CI, no production hardening, and the Docker images run as root. Don't ship as-is.
