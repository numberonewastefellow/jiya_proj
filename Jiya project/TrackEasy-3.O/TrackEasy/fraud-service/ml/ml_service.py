import os
import json
import numpy as np
import tensorflow as tf
import joblib
import pandas as pd
import xgboost as xgb
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional

# Suppress TF logs
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'

app = FastAPI(title="TrackEasy ML Fraud Service", description="High-performance model serving for fraud detection")

BASE_DIR = os.path.dirname(__file__)

# --- Custom Layers ---
class GCNLayer(tf.keras.layers.Layer):
    def __init__(self, units, activation='relu', **kwargs):
        super(GCNLayer, self).__init__(**kwargs)
        self.units = units
        self.activation = tf.keras.activations.get(activation)
    def build(self, input_shape):
        self.w = self.add_weight(shape=(input_shape[0][-1], self.units), initializer='glorot_uniform')
    def call(self, inputs):
        x, a = inputs
        x = tf.matmul(a, x)
        x = tf.matmul(x, self.w)
        return self.activation(x)
    def get_config(self):
        config = super().get_config()
        config.update({"units": self.units, "activation": tf.keras.activations.serialize(self.activation)})
        return config

# --- Global Model Storage ---
models = {}
gnn_context = {}

class PredictionInput(BaseModel):
    # Behavioral (LSTM)
    sequence: Optional[List[int]] = None
    # Ring (GNN)
    userId: Optional[str] = None
    # Anomaly (Autoencoder)
    transaction: Optional[dict] = None # {amount, items, hour, day}
    # Master (ANN, RF, XGB, IF)
    ensemble_features: Optional[dict] = None # {ruleScore, lstmProb, gnnProb, autoMSE, geoSpeed, clusterSize}

@app.on_event("startup")
def load_all_models():
    print("Loading ML models into memory...")
    
    # 1. Behavioral LSTM
    lstm_path = os.path.join(BASE_DIR, 'behavior_model.h5')
    if os.path.exists(lstm_path):
        models['lstm'] = tf.keras.models.load_model(lstm_path)
        print("LSTM model loaded.")
    
    # 2. GNN Ring Detection
    gnn_path = os.path.join(BASE_DIR, 'gnn_model.h5')
    if os.path.exists(gnn_path):
        models['gnn'] = tf.keras.models.load_model(gnn_path, custom_objects={'GCNLayer': GCNLayer})
        # Load Context for GNN
        with open(os.path.join(BASE_DIR, 'node_map.json'), 'r') as f:
            gnn_context['node_map'] = json.load(f)
        gnn_context['nodes_df'] = pd.read_csv(os.path.join(BASE_DIR, 'graph_nodes.csv'))
        gnn_context['edges_df'] = pd.read_csv(os.path.join(BASE_DIR, 'graph_edges.csv'))
        
        # Precompute Adjacency
        num_nodes = len(gnn_context['nodes_df'])
        node_to_idx = gnn_context['node_map']
        adj = np.eye(num_nodes)
        for _, row in gnn_context['edges_df'].iterrows():
            if row['source'] in node_to_idx and row['target'] in node_to_idx:
                i, j = node_to_idx[row['source']], node_to_idx[row['target']]
                adj[i, j] = adj[j, i] = 1
        d = np.diag(np.power(adj.sum(axis=1), -0.5))
        gnn_context['adj_norm'] = d.dot(adj).dot(d)
        gnn_context['X'] = gnn_context['nodes_df'][['f1', 'f2']].values.astype('float32')
        print("GNN model and graph context loaded.")

    # 3. Autoencoder Anomaly
    ae_path = os.path.join(BASE_DIR, 'autoencoder_model.h5')
    scaler_path = os.path.join(BASE_DIR, 'scaler.joblib')
    if os.path.exists(ae_path) and os.path.exists(scaler_path):
        models['autoencoder'] = tf.keras.models.load_model(ae_path)
        models['scaler'] = joblib.load(scaler_path)
        print("Autoencoder model loaded.")

    # 4. Master Brain ANN
    ann_path = os.path.join(BASE_DIR, 'ann_fraud_brain.h5')
    if os.path.exists(ann_path):
        models['ann'] = tf.keras.models.load_model(ann_path)
        print("Master Brain ANN loaded.")

    # 5. Random Forest
    rf_path = os.path.join(BASE_DIR, 'rf_model.joblib')
    if os.path.exists(rf_path):
        models['rf'] = joblib.load(rf_path)
        print("Random Forest model loaded.")

    # 6. XGBoost
    xgb_path = os.path.join(BASE_DIR, 'xgb_model.json')
    if os.path.exists(xgb_path):
        xgb_model = xgb.XGBClassifier()
        xgb_model.load_model(xgb_path)
        models['xgb'] = xgb_model
        print("XGBoost model loaded.")

    # 7. Isolation Forest
    if_path = os.path.join(BASE_DIR, 'iso_forest_model.joblib')
    if os.path.exists(if_path):
        models['isolation_forest'] = joblib.load(if_path)
        print("Isolation Forest model loaded.")

@app.get("/health")
def health_check():
    return {"status": "online", "loaded_models": list(models.keys())}

@app.post("/predict/behavioral")
def predict_behavioral(data: PredictionInput):
    if 'lstm' not in models: raise HTTPException(status_code=503, detail="LSTM model not loaded")
    seq = data.sequence
    if not seq: raise HTTPException(status_code=400, detail="Missing sequence")
    
    if len(seq) < 10: seq = [0] * (10 - len(seq)) + seq
    else: seq = seq[:10]
    
    X = np.array(seq).reshape(1, 10, 1)
    prob = models['lstm'].predict(X, verbose=0)
    return {"probability": float(prob[0][0])}

@app.post("/predict/ring")
def predict_ring(data: PredictionInput):
    if 'gnn' not in models: raise HTTPException(status_code=503, detail="GNN model not loaded")
    uid = data.userId
    if not uid: raise HTTPException(status_code=400, detail="Missing userId")
    
    node_map = gnn_context.get('node_map', {})
    if uid not in node_map:
        return {"probability": 0.0, "reason": "Not in graph"}
    
    idx = node_map[uid]
    preds = models['gnn'].predict([gnn_context['X'], gnn_context['adj_norm']], verbose=0)
    return {"probability": float(preds[idx][0])}

@app.post("/predict/anomaly")
def predict_anomaly(data: PredictionInput):
    if 'autoencoder' not in models: raise HTTPException(status_code=503, detail="Autoencoder not loaded")
    tx = data.transaction
    if not tx: raise HTTPException(status_code=400, detail="Missing transaction data")
    
    X = np.array([[tx['amount'], tx['items'], tx['hour'], tx['day']]])
    scaled = models['scaler'].transform(X)
    pred = models['autoencoder'].predict(scaled, verbose=0)
    mse = np.mean(np.square(scaled - pred))
    
    threshold = 2.5 # Current threshold from predict_anomaly.py
    return {
        "mse": float(mse),
        "is_anomaly": bool(mse > threshold),
        "threshold": threshold
    }

@app.post("/predict/master")
def predict_master(data: PredictionInput):
    if 'ann' not in models: raise HTTPException(status_code=503, detail="Master ANN not loaded")
    feat = data.ensemble_features
    if not feat: raise HTTPException(status_code=400, detail="Missing ensemble features")
    
    X = np.array([[feat['ruleScore'], feat['lstmProb'], feat['gnnProb'], feat['autoMSE'], feat.get('geoSpeed', 0), feat.get('clusterSize', 1)]])
    prob = models['ann'].predict(X, verbose=0)
    return {"probability": float(prob[0][0])}

@app.post("/predict/rf")
def predict_rf(data: PredictionInput):
    if 'rf' not in models: raise HTTPException(status_code=503, detail="Random Forest not loaded")
    feat = data.ensemble_features
    if not feat: raise HTTPException(status_code=400, detail="Missing ensemble features")
    
    X = np.array([[feat['ruleScore'], feat['lstmProb'], feat['gnnProb'], feat['autoMSE'], feat.get('geoSpeed', 0), feat.get('clusterSize', 1)]])
    prob = models['rf'].predict_proba(X)[:, 1]
    return {"probability": float(prob[0])}

@app.post("/predict/xgb")
def predict_xgb(data: PredictionInput):
    if 'xgb' not in models: raise HTTPException(status_code=503, detail="XGBoost not loaded")
    feat = data.ensemble_features
    if not feat: raise HTTPException(status_code=400, detail="Missing ensemble features")
    
    X = np.array([[feat['ruleScore'], feat['lstmProb'], feat['gnnProb'], feat['autoMSE'], feat.get('geoSpeed', 0), feat.get('clusterSize', 1)]])
    prob = models['xgb'].predict_proba(X)[:, 1]
    return {"probability": float(prob[0])}

@app.post("/predict/if")
def predict_if(data: PredictionInput):
    if 'isolation_forest' not in models: raise HTTPException(status_code=503, detail="Isolation Forest not loaded")
    feat = data.ensemble_features
    if not feat: raise HTTPException(status_code=400, detail="Missing ensemble features")
    
    X = np.array([[feat['ruleScore'], feat['lstmProb'], feat['gnnProb'], feat['autoMSE'], feat.get('geoSpeed', 0), feat.get('clusterSize', 1)]])
    # IF returns 1 for inlier, -1 for outlier. Map to 0-1 score roughly.
    score = models['isolation_forest'].decision_function(X) # Higher = more normal
    # Transform to 0-1 where 1 is more anomalous
    prob = 1.0 - (score[0] + 0.5) # Rough normalization
    return {"anomaly_score": float(np.clip(prob, 0.0, 1.0))}

@app.post("/predict/explain")
def explain_master(data: PredictionInput):
    """Calculates local feature attribution (SHAP-like) for the prediction"""
    if 'ann' not in models: raise HTTPException(status_code=503, detail="Master ANN not loaded")
    feat = data.ensemble_features
    if not feat: raise HTTPException(status_code=400, detail="Missing ensemble features")
    
    # 1. Prepare Feature Vector
    features = ['ruleScore', 'lstmProb', 'gnnProb', 'autoMSE', 'geoSpeed', 'clusterSize']
    vals = [feat['ruleScore'], feat['lstmProb'], feat['gnnProb'], feat['autoMSE'], feat.get('geoSpeed', 0), feat.get('clusterSize', 1)]
    X = np.array([vals])
    
    # 2. Get baseline (mean values for the dataset)
    # These are approx averages from our synthetic data generation
    baselines = [2.5, 0.3, 0.3, 2.0, 300, 2]
    
    # 3. Simple Perturbation Attribution
    # We measure how much the prediction changes when a feature is moved from its value to the baseline
    full_prob = models['ann'].predict(X, verbose=0)[0][0]
    
    explanations = []
    for i, name in enumerate(features):
        X_perturbed = X.copy()
        X_perturbed[0, i] = baselines[i]
        perturbed_prob = models['ann'].predict(X_perturbed, verbose=0)[0][0]
        
        # Contribution is the diff caused by THIS feature
        diff = full_prob - perturbed_prob
        explanations.append({"feature": name, "contribution": float(round(diff * 10, 2))}) # Scale to 10 for score impact
        
    return {
        "final_prob": float(full_prob),
        "explanation": explanations,
        "base_value": float(models['ann'].predict(np.array([baselines]), verbose=0)[0][0] * 10)
    }

@app.post("/predict/biometrics")
def predict_biometrics(metrics: dict):
    """
    Analyzes Behavioral Biometrics to detect bots.
    Expected: avgVelocity, maxVelocity, straightLineRatio, scrollJitter, eventCount
    """
    # 1. Decision Logic (can be replaced by a pre-trained model)
    # A human typically has a straightLineRatio < 0.6 and scrollJitter > 2.0
    # A bot typically has straightLineRatio > 0.9 or 0 jitter.
    
    sl_ratio = metrics.get('straightLineRatio', 0)
    jitter = metrics.get('scrollJitter', 0)
    velocity_delta = metrics.get('maxVelocity', 0) - metrics.get('avgVelocity', 0)
    event_count = metrics.get('eventCount', 0)
    
    bot_score = 0.0
    reasons = []
    
    if event_count < 5:
        bot_score += 0.3
        reasons.append("Insufficient data (Too few events)")
    
    if sl_ratio > 0.8:
        bot_score += 0.5
        reasons.append("Robotic movement (Perfectly straight lines)")
    
    if jitter < 1.0 and metrics.get('scrollEventsCount', 0) > 2:
        bot_score += 0.4
        reasons.append("Non-human scrolling (Zero jitter)")
        
    if velocity_delta < 0.01 and event_count > 10:
        bot_score += 0.4
        reasons.append("Constant velocity (Bot-like consistency)")

    final_score = min(1.0, bot_score)
    
    return {
        "bot_probability": float(final_score),
        "is_bot": bool(final_score > 0.7),
        "reasons": reasons,
        "human_confidence": 1.0 - final_score
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
