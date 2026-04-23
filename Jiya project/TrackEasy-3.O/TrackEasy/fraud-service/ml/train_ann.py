import pandas as pd
import numpy as np
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import Dense, Dropout
from tensorflow.keras.callbacks import EarlyStopping
import os

# Paths
BASE_DIR = os.path.dirname(__file__)
DATA_PATH = os.path.join(BASE_DIR, 'ann_master_dataset.csv')
MODEL_PATH = os.path.join(BASE_DIR, 'ann_fraud_brain.h5')

def train():
    print("Starting ANN Master Brain Training...")
    
    if not os.path.exists(DATA_PATH):
        print(f"❌ Error: {DATA_PATH} not found.")
        return

    # 1. Load Data
    df = pd.read_csv(DATA_PATH)
    X = df.drop('label', axis=1).values
    y = df['label'].values

    # 2. Build Model (Multi-Layer Perceptron)
    model = Sequential([
        Dense(16, input_dim=6, activation='relu'), # 6 inputs: ruleScore, lstmProb, gnnProb, autoMSE, geoSpeed, clusterSize
        Dropout(0.1),
        Dense(8, activation='relu'),
        Dense(1, activation='sigmoid') # Final 0-1 probability
    ])

    model.compile(
        optimizer='adam', 
        loss='binary_crossentropy', 
        metrics=['accuracy', tf.keras.metrics.Precision(name='precision')]
    )

    # 3. Train with validation and early stopping
    print("Learning to ensemble signals with Precision focus...")
    early_stop = EarlyStopping(monitor='val_loss', patience=5, restore_best_weights=True)
    
    model.fit(
        X, y, 
        epochs=100, 
        batch_size=16, 
        validation_split=0.2,
        callbacks=[early_stop],
        verbose=1
    )

    # 4. Save
    model.save(MODEL_PATH)
    print(f"Master ANN saved to {MODEL_PATH}")

if __name__ == "__main__":
    train()
