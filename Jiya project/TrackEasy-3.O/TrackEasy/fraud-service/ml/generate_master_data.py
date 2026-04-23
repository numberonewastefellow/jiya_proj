import pandas as pd
import numpy as np
import os

# Paths
BASE_DIR = os.path.dirname(__file__)
DATA_PATH = os.path.join(BASE_DIR, 'ann_master_dataset.csv')

def generate_data(num_samples=2500):
    print(f"Generating {num_samples} samples with Geospatial and Ring features...")
    
    np.random.seed(42)
    
    data = []
    for _ in range(num_samples):
        # Determine if this sample is fraudulent (approx 45% fraud for balanced learning)
        is_fraud = 1 if np.random.random() < 0.45 else 0
        
        if is_fraud:
            # Fraudulent characteristics
            rule_score = np.random.uniform(5, 10)
            lstm_prob = np.random.uniform(0.6, 1.0)
            gnn_prob = np.random.uniform(0.6, 1.0)
            auto_mse = np.random.uniform(3, 10)
            # Geospatial: High speed half the time
            geo_speed = np.random.uniform(800, 2500) if np.random.random() < 0.6 else np.random.uniform(0, 800)
            # Cluster: Larger rings
            cluster_size = np.random.randint(4, 20) if np.random.random() < 0.8 else np.random.randint(1, 4)
        else:
            # Normal characteristics
            rule_score = np.random.uniform(0, 5)
            lstm_prob = np.random.uniform(0, 0.4)
            gnn_prob = np.random.uniform(0, 0.4)
            auto_mse = np.random.uniform(0, 3)
            # Geospatial: Normal speeds
            geo_speed = np.random.uniform(0, 400)
            # Cluster: Most users are isolated or in small groups
            cluster_size = np.random.randint(1, 3)
            
        data.append({
            'ruleScore': round(rule_score, 2),
            'lstmProb': round(lstm_prob, 2),
            'gnnProb': round(gnn_prob, 2),
            'autoMSE': round(auto_mse, 2),
            'geoSpeed': round(geo_speed, 2),
            'clusterSize': cluster_size,
            'label': is_fraud
        })
    
    df = pd.DataFrame(data)
    df.to_csv(DATA_PATH, index=False)
    print(f"Successfully saved 6-feature dataset to {DATA_PATH}")

if __name__ == "__main__":
    generate_data()
