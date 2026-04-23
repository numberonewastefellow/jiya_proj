import pandas as pd
import numpy as np
import joblib
import os
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report

# Paths
BASE_DIR = os.path.dirname(__file__)
DATA_PATH = os.path.join(BASE_DIR, 'ann_master_dataset.csv')
MODEL_PATH = os.path.join(BASE_DIR, 'rf_model.joblib')

def train():
    print("Starting Random Forest Model Training...")
    
    if not os.path.exists(DATA_PATH):
        print(f"❌ Error: {DATA_PATH} not found.")
        return

    # 1. Load Data
    df = pd.read_csv(DATA_PATH)
    X = df.drop('label', axis=1).values
    y = df['label'].values

    # 2. Split Data
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    # 3. Build & Train Model
    print("Training Random Forest with balanced class weights...")
    model = RandomForestClassifier(
        n_estimators=200,
        max_depth=12,
        class_weight='balanced',
        random_state=42,
        n_jobs=-1
    )
    
    model.fit(X_train, y_train)

    # 4. Evaluate
    y_pred = model.predict(X_test)
    print("\nTest Set Results:")
    print(classification_report(y_test, y_pred))

    # 5. Save Model
    joblib.dump(model, MODEL_PATH)
    print(f"SUCCESS: Random Forest saved to {MODEL_PATH}")

if __name__ == "__main__":
    train()
