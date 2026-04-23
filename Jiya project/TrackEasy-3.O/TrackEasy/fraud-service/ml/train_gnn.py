import pandas as pd
import numpy as np
import tensorflow as tf
from tensorflow.keras.models import Model
from tensorflow.keras.layers import Input, Dense, Dropout
from tensorflow.keras.callbacks import EarlyStopping
import os
import json

# Note: We'll use a simple Graph Convolutional approach
# In a full production env, you'd use Spektral or PyG.
# For this implementation, I'll provide a robust custom GCN layer.

class GCNLayer(tf.keras.layers.Layer):
    def __init__(self, units, activation='relu'):
        super(GCNLayer, self).__init__()
        self.units = units
        self.activation = tf.keras.activations.get(activation)

    def build(self, input_shape):
        self.w = self.add_weight(shape=(input_shape[0][-1], self.units), initializer='glorot_uniform')

    def call(self, inputs):
        # inputs[0] = features, inputs[1] = adjacency matrix (normalized)
        x, a = inputs
        x = tf.matmul(a, x)
        x = tf.matmul(x, self.w)
        return self.activation(x)

def train():
    print("Starting GNN Model Training (Fraud Ring Detection)...")
    
    nodes_df = pd.read_csv('graph_nodes.csv')
    edges_df = pd.read_csv('graph_edges.csv')

    # 1. Prepare Adjacency Matrix
    num_nodes = len(nodes_df)
    node_to_idx = {id: i for i, id in enumerate(nodes_df['id'])}
    
    adj = np.eye(num_nodes) # Self-connections
    for _, row in edges_df.iterrows():
        if row['source'] in node_to_idx and row['target'] in node_to_idx:
            i, j = node_to_idx[row['source']], node_to_idx[row['target']]
            adj[i, j] = 1
            adj[j, i] = 1 # Undirected

    # Normalize Adjacency
    d = np.diag(np.power(adj.sum(axis=1), -0.5))
    adj_norm = d.dot(adj).dot(d)

    # 2. Features and Labels
    X = nodes_df[['f1', 'f2']].values.astype('float32')
    y = nodes_df['isBlocked'].values.astype('float32')

    # 3. Build Model
    feat_in = Input(shape=(2,))
    adj_in = Input(shape=(num_nodes,))
    
    h = GCNLayer(32)([feat_in, adj_in])
    h = Dropout(0.2)(h)
    h = GCNLayer(16)([h, adj_in])
    out = Dense(1, activation='sigmoid')(h)

    model = Model(inputs=[feat_in, adj_in], outputs=out)
    model.compile(
        optimizer='adam', 
        loss='binary_crossentropy', 
        metrics=['accuracy', tf.keras.metrics.Precision(name='precision')]
    )

    # 4. Train with Early Stopping to prevent overfitting (reduces false positives)
    print("Training Graph Neural Network with Precision focus...")
    early_stop = EarlyStopping(monitor='loss', patience=5, restore_best_weights=True)
    
    model.fit(
        [X, adj_norm], y, 
        epochs=100, 
        batch_size=num_nodes,
        callbacks=[early_stop],
        verbose=1
    )

    # 5. Save Model and Metadata
    model.save('gnn_model.h5')
    # Save node_to_idx for prediction lookups
    with open('node_map.json', 'w') as f:
        json.dump(node_to_idx, f)
        
    print("GNN Model saved to gnn_model.h5")

if __name__ == "__main__":
    os.chdir(os.path.dirname(__file__))
    train()
