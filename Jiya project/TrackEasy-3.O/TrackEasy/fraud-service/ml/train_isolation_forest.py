import pandas as pd
import numpy as np
import joblib
import os
from sklearn.ensemble import IsolationForest
from sklearn.metrics import classification_report

# Paths
BASE_DIR = os.path.dirname(__file__)
DATA_PATH = os.path.join(BASE_DIR, 'ann_master_dataset.csv')
MODEL_PATH = os.path.join(BASE_DIR, 'iso_forest_model.joblib')

def train():
    print("Starting Isolation Forest Model Training...")
    
    if not os.path.exists(DATA_PATH):
        print(f"❌ Error: {DATA_PATH} not found.")
        return

    # 1. Load Data
    df = pd.read_csv(DATA_PATH)
    X = df.drop('label', axis=1).values
    y = df['label'].values # Labels used for evaluation only

    # 2. Build & Train Model (Unsupervised)
    # Contamination is the expected proportion of outliers in the data
    fraud_rate = np.mean(y)
    print(f"Estimated contamination (fraud rate): {fraud_rate:.4f}")

    model = IsolationForest(
        n_estimators=100,
        contamination=min(0.5, max(0.01, fraud_rate)),
        random_state=42,
        n_jobs=-1
    )
    
    print("Fitting Isolation Forest...")
    model.fit(X)

    # 3. Evaluate
    # IF returns 1 for inliers and -1 for outliers. Map to 0 and 1.
    y_pred_raw = model.predict(X)
    y_pred = [1 if x == -1 else 0 for x in y_pred_raw]
    
    print("\nTraining Set Evaluation (In-sample):")
    print(classification_report(y, y_pred))

    # 4. Save Model
    joblib.dump(model, MODEL_PATH)
    print(f"SUCCESS: Isolation Forest saved to {MODEL_PATH}")

if __name__ == "__main__":
    train()
