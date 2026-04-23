import pandas as pd
import numpy as np
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout, Embedding
from tensorflow.keras.callbacks import EarlyStopping
from sklearn.utils import class_weight
import os

# Configuration
DATA_PATH = os.path.join(os.path.dirname(__file__), 'behavioral_dataset.csv')
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'behavior_model.h5')

def train():
    print("Starting LSTM Model Training...")
    
    if not os.path.exists(DATA_PATH):
        print("Error: Dataset not found")
        return

    # 1. Load Data
    df = pd.read_csv(DATA_PATH)
    X = df.drop('label', axis=1).values
    y = df['label'].values

    # 2. Preprocess
    X = X.reshape(X.shape[0], X.shape[1], 1)

    # Calculate class weights for imbalance
    weights = class_weight.compute_class_weight('balanced', classes=np.unique(y), y=y)
    class_weights = dict(enumerate(weights))

    # 3. Build Model
    model = Sequential([
        LSTM(64, input_shape=(10, 1), return_sequences=False),
        Dropout(0.3), # Increased dropout to prevent overfitting
        Dense(32, activation='relu'),
        Dense(1, activation='sigmoid')
    ])

    # Focus on Precision and AUC to reduce False Positives
    model.compile(
        optimizer='adam', 
        loss='binary_crossentropy', 
        metrics=['accuracy', tf.keras.metrics.Precision(name='precision'), tf.keras.metrics.AUC(name='auc')]
    )

    # 4. Train with Early Stopping
    print("Training with Precision monitoring and EarlyStopping...")
    early_stop = EarlyStopping(monitor='val_loss', patience=3, restore_best_weights=True)
    
    model.fit(
        X, y, 
        epochs=50, 
        batch_size=32, 
        validation_split=0.2,
        class_weight=class_weights,
        callbacks=[early_stop],
        verbose=1
    )

    # 5. Save
    model.save(MODEL_PATH)
    print(f"Model saved to {MODEL_PATH}")

if __name__ == "__main__":
    train()
