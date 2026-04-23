import sys
import os
import json
import numpy as np
import tensorflow as tf

# Suppress TF logs
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3' 

MODEL_PATH = os.path.join(os.path.dirname(__file__), 'behavior_model.h5')

def predict(sequence):
    try:
        model = tf.keras.models.load_model(MODEL_PATH)
        
        # Prepare sequence: (1, 10, 1)
        X = np.array(sequence).reshape(1, 10, 1)
        
        prediction = model.predict(X, verbose=0)
        return float(prediction[0][0])
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No sequence provided"}))
        sys.exit(1)
        
    try:
        # Input sequence passed as comma-separated string
        seq_str = sys.argv[1]
        seq = [int(x) for x in seq_str.split(',')]
        
        # Ensure sequence length is 10
        if len(seq) < 10:
            seq = [0] * (10 - len(seq)) + seq
        else:
            seq = seq[:10]
            
        result = predict(seq)
        print(json.dumps({"probability": result}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
