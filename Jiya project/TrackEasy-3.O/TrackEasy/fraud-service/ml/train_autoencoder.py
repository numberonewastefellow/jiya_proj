import pandas as pd
import numpy as np
import tensorflow as tf
from tensorflow.keras.models import Model
from tensorflow.keras.layers import Input, Dense
from tensorflow.keras.callbacks import EarlyStopping
from sklearn.preprocessing import StandardScaler
import joblib
import os

# Paths
BASE_DIR = os.path.dirname(__file__)
DATA_PATH = os.path.join(BASE_DIR, 'normal_transactions.csv')
MODEL_PATH = os.path.join(BASE_DIR, 'autoencoder_model.h5')
SCALER_PATH = os.path.join(BASE_DIR, 'scaler.joblib')

def train():
    print("Starting Autoencoder Training (Anomaly Detection)...")
    
    if not os.path.exists(DATA_PATH):
        print("❌ Error: normal_transactions.csv not found.")
        return

    # 1. Load Data
    df = pd.read_csv(DATA_PATH)
    X = df.values

    # 2. Scale Data (Critical for Autoencoders)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    joblib.dump(scaler, SCALER_PATH)

    # 3. Build Model (Bottleneck Architecture)
    input_dim = X.shape[1] # 4 features
    
    input_layer = Input(shape=(input_dim,))
    
    # Encoder
    encoded = Dense(8, activation='relu')(input_layer)
    encoded = Dense(2, activation='relu')(encoded) # Bottleneck
    
    # Decoder
    decoded = Dense(8, activation='relu')(encoded)
    decoded = Dense(input_dim, activation='linear')(decoded)
    
    autoencoder = Model(input_layer, decoded)
    autoencoder.compile(optimizer='adam', loss='mean_squared_error')

    # 4. Train with Early Stopping
    print("Learning normal patterns with EarlyStopping...")
    early_stop = EarlyStopping(monitor='val_loss', patience=5, restore_best_weights=True)
    
    autoencoder.fit(
        X_scaled, X_scaled, 
        epochs=100, 
        batch_size=32, 
        validation_split=0.1,
        callbacks=[early_stop],
        verbose=1, 
        shuffle=True
    )

    # 5. Save
    autoencoder.save(MODEL_PATH)
    print(f"Autoencoder saved to {MODEL_PATH}")
    print(f"Scaler saved to {SCALER_PATH}")

if __name__ == "__main__":
    train()
