import sys
import os
import json
import numpy as np
import tensorflow as tf

# Suppress TF logs
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3' 

BASE_DIR = os.path.dirname(__file__)
MODEL_PATH = os.path.join(BASE_DIR, 'ann_fraud_brain.h5')

def predict(ruleScore, lstmProb, gnnProb, autoMSE):
    try:
        if not os.path.exists(MODEL_PATH):
            return {"error": "Master ANN not trained yet"}

        model = tf.keras.models.load_model(MODEL_PATH)

        # Input vector
        X = np.array([[ruleScore, lstmProb, gnnProb, autoMSE]])
        
        prediction = model.predict(X, verbose=0)
        
        return float(prediction[0][0])

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print(json.dumps({"error": "Missing parameters [ruleScore, lstmProb, gnnProb, autoMSE]"}))
        sys.exit(1)
        
    try:
        res = predict(
            float(sys.argv[1]), 
            float(sys.argv[2]), 
            float(sys.argv[3]), 
            float(sys.argv[4])
        )
        print(json.dumps({"probability": res}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
