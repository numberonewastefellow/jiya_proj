import sys
import os
import json
import numpy as np
import tensorflow as tf
import pandas as pd

# Suppress TF logs
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3' 

# Load custom GCN layer if needed for loading.
# If saved as .h5 with custom layers, we need custom_objects.
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

def predict(user_id):
    ml_dir = os.path.dirname(__file__)
    model_path = os.path.join(ml_dir, 'gnn_model.h5')
    map_path = os.path.join(ml_dir, 'node_map.json')
    nodes_path = os.path.join(ml_dir, 'graph_nodes.csv')
    edges_path = os.path.join(ml_dir, 'graph_edges.csv')

    try:
        if not os.path.exists(model_path):
            return {"error": "GNN Model not trained yet"}

        # 1. Load context
        with open(map_path, 'r') as f:
            node_to_idx = json.load(f)
        
        if user_id not in node_to_idx:
            return {"probability": 0.0, "reason": "New user, not in graph yet"}

        idx = node_to_idx[user_id]
        
        # 2. Rebuild Adjacency (Sub-graph would be better, but we'll do full for now)
        nodes_df = pd.read_csv(nodes_path)
        edges_df = pd.read_csv(edges_path)
        num_nodes = len(nodes_df)
        
        adj = np.eye(num_nodes)
        for _, row in edges_df.iterrows():
            if row['source'] in node_to_idx and row['target'] in node_to_idx:
                i, j = node_to_idx[row['source']], node_to_idx[row['target']]
                adj[i, j] = 1
                adj[j, i] = 1
        
        d = np.diag(np.power(adj.sum(axis=1), -0.5))
        adj_norm = d.dot(adj).dot(d)
        
        X = nodes_df[['f1', 'f2']].values.astype('float32')

        # 3. Load Model and Predict
        model = tf.keras.models.load_model(model_path, custom_objects={'GCNLayer': GCNLayer})
        predictions = model.predict([X, adj_norm], verbose=0)
        
        return float(predictions[idx][0])

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No User ID provided"}))
        sys.exit(1)
        
    res = predict(sys.argv[1])
    if isinstance(res, dict):
        print(json.dumps(res))
    else:
        print(json.dumps({"probability": res}))
