require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const geoip = require('geoip-lite');
const { execSync } = require('child_process');
const path = require('path');
const axios = require('axios');

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';

const app = express();
const PORT = process.env.PORT || 5002;

// Middleware
app.use(cors());
app.use(express.json());

// Import Models
// Note: We're reusing the models from the main app's codebase.
const EventLog = require('../server/models/EventLog');
const FraudAlert = require('../server/models/FraudAlert');
const UserSession = require('../server/models/UserSession');

// MongoDB connection
// Use the same DB URI from your main server's .env file, or a separate one for the microservice.
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/trackeasy';
console.log('🔗 Connecting to:', MONGODB_URI);
mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('✅ Connected to MongoDB (Fraud Service)');
        console.log('🔌 Connection State:', mongoose.connection.readyState);
    })
    .catch((err) => console.error('❌ MongoDB connection error:', err));

// --- Helper Functions ---

/**
 * Calculates the distance between two coordinates in kilometers using the Haversine formula.
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2)
    ;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in km
}

/**
 * Resolves an IP address to geographic coordinates.
 * Includes a mock for local development IPs.
 */
function resolveGeoIP(ip) {
    // Handle localhost/mock cases for demonstration
    // In production, we would use the real IP.
    // For this project, if the IP is localhost, we return a baseline Mumbai location.
    // If the client provides a custom mock IP (like '8.8.8.8'), we resolve it.
    if (ip === '::1' || ip === '127.0.0.1' || !ip) {
        return { lat: 19.0760, lon: 72.8777, city: 'Mumbai (Mock)', country: 'IN' };
    }
    
    const geo = geoip.lookup(ip);
    if (geo) {
        return { 
            lat: geo.ll[0], 
            lon: geo.ll[1], 
            city: geo.city || 'Unknown', 
            country: geo.country 
        };
    }
    return null;
}

// --- API Endpoints ---

// 1. Log Event (To receive activity from the e-commerce site)
// POST /api/fraud/log-event
app.post('/api/fraud/log-event', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            throw new Error('Database not connected. Ready state: ' + mongoose.connection.readyState);
        }
        const { userId, eventType, ipAddress, deviceFingerprint } = req.body;
        
        const location = resolveGeoIP(ipAddress);

        // Save the event to the database
        const newEvent = new EventLog({
            userId,
            eventType,
            ipAddress,
            location,
            deviceFingerprint,
            timestamp: new Date()
        });
        await newEvent.save();

        console.log(`[EVENT LOGGED] User: ${userId}, Event: ${eventType}, Location: ${location ? location.city : 'Unknown'}`);
        res.status(200).json({ message: 'Event logged successfully' });
    } catch (error) {
        console.error('Log event error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Evaluate Transaction (To calculate the score before checkout)
// POST /api/fraud/evaluate-transaction
app.post('/api/fraud/evaluate-transaction', async (req, res) => {
    try {
        const { userId, transactionDetails } = req.body;
        
        // Fetch recent events for the user to analyze behavior
        const recentEvents = await EventLog.find({ userId })
            .sort({ timestamp: -1 })
            .limit(20); // Look at last 20 events

        let riskScore = 0;
        let action = 'allow';
        let violationReasons = [];
        let geoSpeed = 0;
        let clusterSize = 1;
        
        // Rule 1: High frequency of add_to_cart (bot-like browsing)
        const addToCartEvents = recentEvents.filter(e => e.eventType === 'add_to_cart');
        if (addToCartEvents.length > 5) {
            // Give 1 risk point for EVERY item they rapidly added to the cart
            riskScore += (addToCartEvents.length * 1);
            violationReasons.push(`High frequency cart additions (${addToCartEvents.length} items)`);
        }

        // Rule 2: Multiple payment failures
        const failedPayments = recentEvents.filter(e => e.eventType === 'payment_failed');
        if (failedPayments.length >= 2) {
            riskScore += 4;
            violationReasons.push("Multiple failed payment attempts");
        }

        // Rule 3: Speed Check: checkout way too fast after login
        const loginEvent = recentEvents.find(e => e.eventType === 'login');
        if (loginEvent && (new Date() - new Date(loginEvent.timestamp)) < 15000) {
            // Under 15 seconds from login to checkout
            riskScore += 3;
            violationReasons.push("Unusually fast checkout process");
        }

        // Rule 4: Historical Order Quantity Anomaly (Suspension Rule)
        if (transactionDetails && transactionDetails.items && transactionDetails.items.length > 0) {
            const Order = require('../server/models/Order');
            const pastOrders = await Order.find({ customer: userId, status: { $ne: 'Rejected' } });
            
            if (pastOrders.length > 0) {
                // Calculate average items per order
                const totalPastItems = pastOrders.reduce((sum, order) => sum + (order.items?.length || 0), 0);
                const avgItemsPerOrder = totalPastItems / pastOrders.length;
                
                // If they are adding 3x more products than their average (and at least 5 products total to prevent false positives on tiny accounts)
                if (transactionDetails.items.length > (avgItemsPerOrder * 3) && transactionDetails.items.length >= 5) {
                    riskScore += 7; // Massive score to guarantee block
                    violationReasons.push(`Abnormal quantity anomaly. Past Avg: ${Math.round(avgItemsPerOrder)}, Current Cart: ${transactionDetails.items.length}`);
                    
                    console.log(`[USER FLAGGED] ${userId} exceeded historical item average. OTP required.`);
                }
            }
        }

        // Rule 5: Geospatial Anomaly ("Superman" Check)
        const currentIp = req.body.ipAddress || req.ip;
        const currentLocation = resolveGeoIP(currentIp);
        
        if (currentLocation && recentEvents.length > 0) {
            // Find the most recent event with a valid location
            const lastEventWithLocation = recentEvents.find(e => e.location && e.location.lat);
            
            if (lastEventWithLocation) {
                const distanceKm = calculateDistance(
                    lastEventWithLocation.location.lat,
                    lastEventWithLocation.location.lon,
                    currentLocation.lat,
                    currentLocation.lon
                );
                
                const timeDiffHours = (new Date() - new Date(lastEventWithLocation.timestamp)) / (1000 * 60 * 60);
                
                if (timeDiffHours > 0) {
                    const speedKmh = distanceKm / timeDiffHours;
                    
                    // Threshold: 1000 km/h (Commercial flight speed)
                    // We only check if distance is significant (e.g., > 10km) to avoid jitter/IP change noise
                    geoSpeed = speedKmh;
                    if (speedKmh > 1000 && distanceKm > 50) {
                        riskScore += 8;
                        violationReasons.push(`Geospatial Anomaly: Travelled ${Math.round(distanceKm)}km at ${Math.round(speedKmh)}km/h (Impossible Speed)`);
                        console.log(`[SUPERMAN ALERT] User ${userId} flagged for impossible travel speed: ${Math.round(speedKmh)}km/h`);
                    }
                }
            }
        }

        // Rule 6: Deep Learning Sequence Analysis (Behavioral Pattern Recognition)
        const EVENT_MAP = {
            'login': 1,
            'add_to_cart': 2,
            'remove_from_cart': 3,
            'checkout_attempt': 4,
            'payment_failed': 5,
            'payment_success': 6
        };

        if (recentEvents.length >= 5) {
            // Map the last 10 event types to their numeric IDs
            const sequenceIds = recentEvents
                .slice(0, 10)
                .map(e => EVENT_MAP[e.eventType] || 0)
                .reverse() // Correct chronological order
                .join(',');

            try {
                // Call the Deep Learning bridge via FastAPI
                const response = await axios.post(`${ML_SERVICE_URL}/predict/behavioral`, { 
                    sequence: sequenceIds.split(',').map(Number) 
                });
                const result = response.data;

                if (result.probability > 0.85) { // Updated to High Confidence threshold
                    riskScore += 5;
                    violationReasons.push(`Deep Learning: Abnormal behavioral sequence detected (Prob: ${Math.round(result.probability * 100)}%)`);
                    console.log(`[DEEP LEARNING FLAG] User ${userId} flagged with high fraud probability: ${result.probability}`);
                }
            } catch (dlError) {
                console.error('[DL ERROR] Could not reach ML service for behavioral prediction:', dlError.message);
            }
        }

        // Rule 7: Graph Anomaly Detection (GNN Fraud Ring)
        try {
            const response = await axios.post(`${ML_SERVICE_URL}/predict/ring`, { userId });
            const gnnResult = response.data;

            if (gnnResult.probability > 0.85) { // High Confidence
                riskScore += 6;
                violationReasons.push(`Graph Neural Network: Highly connected to known fraud cluster (Risk: ${Math.round(gnnResult.probability * 100)}%)`);
                console.log(`[GNN FLAG] User ${userId} identified as part of a fraud ring. Risk Prob: ${gnnResult.probability}`);
            }
        } catch (gnnError) {
            console.error('[GNN ERROR] Could not reach ML service for ring detection:', gnnError.message);
        }

        // Rule 8: Unsupervised Anomaly Check (Autoencoder)
        if (transactionDetails) {
            try {
                const now = new Date();
                const amount = transactionDetails.totalSum || 0;
                const items = transactionDetails.items ? transactionDetails.items.length : 0;
                const hour = now.getHours();
                const day = now.getDay();

                const autoResponse = await axios.post(`${ML_SERVICE_URL}/predict/anomaly`, { 
                    transaction: { amount, items, hour, day } 
                });
                const autoResult = autoResponse.data;

                if (autoResult.is_anomaly) {
                    riskScore += 4;
                    violationReasons.push(`Deep Learning: Unsupervised anomaly detected (Error: ${autoResult.mse.toFixed(2)})`);
                    console.log(`[ANOMALY FLAG] Transaction for ${userId} flagged as outlier by Autoencoder.`);
                }

                // Rule 11: Phantom Honeypot Trap (Definitive Bot Detection)
                if (req.body.hp_trap === true) {
                    riskScore += 20; // Maximum risk
                    action = 'block';
                    violationReasons.push(`Phantom Honeypot: Bot interaction detected in hidden secure controls.`);
                    console.log(`[TRAP ACTIVATED] Bot caught filling honeypot fields for user ${userId}. Instant block.`);
                }

                // Rule 9: Behavioral Biometrics (Silent Bot Detection)
                const biometrics = req.body.biometrics;
                if (biometrics && biometrics.eventCount > 0) {
                    try {
                        const bioResponse = await axios.post(`${ML_SERVICE_URL}/predict/biometrics`, biometrics);
                        const bioResult = bioResponse.data;

                        if (bioResult.is_bot) {
                            riskScore += 9;
                            violationReasons.push(`Behavioral Biometrics: Advanced Bot Behavior detected (${Math.round(bioResult.bot_probability * 100)}%) - [${bioResult.reasons.join(", ")}]`);
                        }
                    } catch (bioError) {
                        console.error('[BIOMETRICS ERROR] ML analysis failed:', bioError.message);
                    }
                }

                // Rule 10: Maniacal Speed Detection (Checkout Velocity)
                if (biometrics && biometrics.duration) {
                    const User = require('../server/models/User'); 
                    const user = await User.findById(userId);
                    
                    if (user && user.lastCheckoutDuration) {
                        const currentDuration = biometrics.duration;
                        const previousDuration = user.lastCheckoutDuration;
                        
                        // User-requested logic: Block if current checkout is < 1/3rd of previous (i.e. 3x faster)
                        if (currentDuration < (previousDuration / 3)) {
                            riskScore += 10;
                            action = 'block';
                            violationReasons.push(`Maniacal Speed: Current checkout (${Math.round(currentDuration/1000)}s) is 3x faster than typical pattern (${Math.round(previousDuration/1000)}s). Bot-like execution suspected.`);
                        }
                    }
                    
                    if (user && riskScore < 5) {
                        user.lastCheckoutDuration = biometrics.duration;
                        await user.save();
                    }
                }

                // --- FINAL ANN MASTER BRAIN ENSEMBLE ---
                let xaiExplanation = null;
                try {
                    const lstmProb = (typeof result !== 'undefined' && result.probability) ? result.probability : 0;
                    const gnnProb = (typeof gnnResult !== 'undefined' && gnnResult.probability) ? gnnResult.probability : 0;
                    const autoMSE = (typeof autoResult !== 'undefined' && autoResult.mse) ? autoResult.mse : 0;
                    
                    // Predict probability
                    const brainResponse = await axios.post(`${ML_SERVICE_URL}/predict/master`, {
                        ensemble_features: { ruleScore, lstmProb, gnnProb, autoMSE, geoSpeed, clusterSize }
                    });
                    const brainResult = brainResponse.data;

                    // Get XAI Explanation
                    const explainResponse = await axios.post(`${ML_SERVICE_URL}/predict/explain`, {
                        ensemble_features: { ruleScore, lstmProb, gnnProb, autoMSE, geoSpeed, clusterSize }
                    });
                    xaiExplanation = explainResponse.data.explanation;

                    if (brainResult.probability) {
                        const brainProb = brainResult.probability;
                        console.log(`[MASTER BRAIN] Final Ensemble Fraud Probability: ${Math.round(brainProb * 100)}%`);
                        
                        if (brainProb > 0.9) { // Very High Confidence for Master Brain
                            action = 'requires_otp';
                            violationReasons.push(`ANN Master Brain: Extremely high risk ensemble detection (${Math.round(brainProb * 100)}%)`);
                        }
                    }
                } catch (brainError) {
                    console.error('[BRAIN ERROR] Could not reach ML service for ensemble/explanation:', brainError.message);
                }
            } catch (autoError) {
                console.error('[AUTO ERROR] Could not reach ML service for anomaly detection:', autoError.message);
            }
        }


        // Cap the risk score at 10
        riskScore = Math.min(10, riskScore);

        if (riskScore > 8) {
            action = 'block';
            try {
                const User = require('../server/models/User');
                await User.findByIdAndUpdate(userId, { 
                    isBlocked: true,
                    blockReason: `Auto-Blocked by System: Risk Score reached ${riskScore}`
                });
                console.log(`[AUTO-BLOCK] User ${userId} blocked due to critical risk score of ${riskScore}.`);
            } catch (e) {
                console.error("Failed to auto-block user:", e);
            }
        } else if (riskScore > 6) {
            action = 'requires_otp';
        } else if (riskScore > 3) {
            action = 'warning';
        }

        // ALWAYS save/log the fraud alert so the manager can see the risk score
        const alert = new FraudAlert({
            userId,
            transactionId: `TXN-${Date.now()}`,
            riskScore,
            violationReason: violationReasons.length > 0 ? violationReasons.join(' | ') : 'No anomalies detected',
            status: riskScore > 6 ? 'Pending' : 'Resolved', // Auto-resolve low-risk scores
            explanation: xaiExplanation // Store local feature attribution (SHAP-like data)
        });
        await alert.save();

        console.log(`[EVALUATION] User: ${userId}, Score: ${riskScore}, Action: ${action}`);
        res.status(200).json({ riskScore, action, reasons: violationReasons, explanation: xaiExplanation });
    } catch (error) {
        console.error('Evaluate transaction error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. Get Alerts (For the admin dashboard)
// GET /api/fraud/alerts
app.get('/api/fraud/alerts', async (req, res) => {
    try {
        const alerts = await FraudAlert.find()
            .populate('userId', 'username email') // Link back to the customer's details
            .sort({ createdAt: -1 });

        res.status(200).json(alerts);
    } catch (error) {
        console.error('Fetch alerts error:', error);
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/fraud/alerts/:id
app.put('/api/fraud/alerts/:id', async (req, res) => {
    try {
        const { status, blockUser } = req.body; 
        const alertId = req.params.id;
        
        const alert = await FraudAlert.findByIdAndUpdate(alertId, { status }, { new: true });
        if (!alert) return res.status(404).json({ message: 'Alert not found' });

        if (blockUser && alert.userId) {
            // Import the User model to block them
            const User = require('../server/models/User');
            await User.findByIdAndUpdate(alert.userId, { 
                isBlocked: true,
                blockReason: `Fraud Detection: ${alert.violationReason}`
            });
        }

        res.status(200).json({ message: 'Alert updated successfully', alert });
    } catch (error) {
        console.error('Update alert error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. Get Graph Data (For Fraud Ring Visualization)
// GET /api/fraud/graph-data
app.get('/api/fraud/graph-data', async (req, res) => {
    try {
        const User = require('../server/models/User');
        const users = await User.find({ role: 'customer' }).select('username email phoneNumber address isBlocked');
        
        let nodes = [];
        let edges = [];
        let edgeSet = new Set();

        // 1. Create nodes for all customers
        users.forEach(user => {
            nodes.push({
                data: { 
                    id: user._id.toString(), 
                    label: user.username,
                    isBlocked: user.isBlocked,
                    type: 'user'
                }
            });
        });

        // 2. Find connections based on static fields
        for (let i = 0; i < users.length; i++) {
            for (let j = i + 1; j < users.length; j++) {
                const u1 = users[i];
                const u2 = users[j];
                let connections = [];

                if (u1.phoneNumber && u1.phoneNumber === u2.phoneNumber) connections.push('Same Phone');
                if (u1.address && u1.address === u2.address) connections.push('Same Address');

                if (connections.length > 0) {
                    const edgeId = `edge-${u1._id}-${u2._id}`;
                    edges.push({
                        data: {
                            id: edgeId,
                            source: u1._id.toString(),
                            target: u2._id.toString(),
                            label: connections.join(', ')
                        }
                    });
                    edgeSet.add(edgeId);
                }
            }
        }

        // 4. Find connections based on device fingerprint history
        const deviceLogs = await EventLog.find({ deviceFingerprint: { $ne: null, $ne: 'unknown' } }).select('userId deviceFingerprint');
        const deviceMap = {}; // fingerprint -> [userIds]
        deviceLogs.forEach(log => {
            if (!log.userId) return;
            const uid = log.userId.toString();
            if (!deviceMap[log.deviceFingerprint]) deviceMap[log.deviceFingerprint] = new Set();
            deviceMap[log.deviceFingerprint].add(uid);
        });

        Object.keys(deviceMap).forEach(fp => {
            const userIds = Array.from(deviceMap[fp]);
            if (userIds.length > 1) {
                for (let i = 0; i < userIds.length; i++) {
                    for (let j = i + 1; j < userIds.length; j++) {
                        const idA = userIds[i];
                        const idB = userIds[j];
                        if (idA === idB) continue;
                        
                        const edgeId = idA < idB ? `edge-fp-${idA}-${idB}` : `edge-fp-${idB}-${idA}`;
                        if (!edgeSet.has(edgeId)) {
                            edges.push({
                                data: {
                                    id: edgeId,
                                    source: idA,
                                    target: idB,
                                    label: 'Same Device'
                                }
                            });
                            edgeSet.add(edgeId);
                        }
                    }
                }
            }
        });

        res.status(200).json({ nodes, edges });
    } catch (error) {
        console.error('Graph data error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. Bulk Block Users (For Fraud Ring)
// POST /api/fraud/bulk-block
app.post('/api/fraud/bulk-block', async (req, res) => {
    try {
        const { userIds } = req.body;
        const User = require('../server/models/User');
        await User.updateMany({ _id: { $in: userIds } }, { isBlocked: true });
        res.status(200).json({ message: `${userIds.length} users blocked successfully` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🛡️  Fraud Detection Service running on http://localhost:${PORT}`);
});
