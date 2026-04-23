import sys
import os
import json
import numpy as np
import tensorflow as tf
import joblib

# Suppress TF logs
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3' 

BASE_DIR = os.path.dirname(__file__)
MODEL_PATH = os.path.join(BASE_DIR, 'autoencoder_model.h5')
SCALER_PATH = os.path.join(BASE_DIR, 'scaler.joblib')

# Define threshold (MSE). 
# This should ideally be found by calculating the 95th percentile of errors on valid data.
THRESHOLD = 2.5 

def predict(amount, items, hour, day):
    try:
        if not os.path.exists(MODEL_PATH):
            return {"error": "Autoencoder not trained yet"}

        # 1. Load context
        model = tf.keras.models.load_model(MODEL_PATH)
        scaler = joblib.load(SCALER_PATH)

        # 2. Prepare and Scale Input
        X = np.array([[amount, items, hour, day]])
        X_scaled = scaler.transform(X)

        # 3. Predict / Reconstruct
        X_pred = model.predict(X_scaled, verbose=0)

        # 4. Calculate Reconstruction Error (MSE)
        mse = np.mean(np.square(X_scaled - X_pred))
        
        is_anomaly = bool(mse > THRESHOLD)

        return {
            "mse": float(mse),
            "threshold": THRESHOLD,
            "is_anomaly": is_anomaly
        }

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print(json.dumps({"error": "Missing parameters [amount, items, hour, day]"}))
        sys.exit(1)
        
    try:
        res = predict(
            float(sys.argv[1]), 
            float(sys.argv[2]), 
            float(sys.argv[3]), 
            float(sys.argv[4])
        )
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
