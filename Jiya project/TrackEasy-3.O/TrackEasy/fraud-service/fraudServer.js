require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const geoip = require('geoip-lite');
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
const User = require('../server/models/User');
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
/**
 * Validate a simulatedLocation object posted from the client demo picker.
 * Returns a normalised {lat, lon, city, country, source} or null if invalid.
 * Purely opt-in; never trusted as a security signal.
 */
function normaliseSimulatedLocation(sim) {
    if (!sim || typeof sim !== 'object') return null;
    const lat = Number(sim.lat);
    const lon = Number(sim.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return {
        lat,
        lon,
        city: typeof sim.city === 'string' ? sim.city.slice(0, 64) : 'Simulated',
        country: typeof sim.country === 'string' ? sim.country.slice(0, 8) : 'XX',
        source: typeof sim.source === 'string' ? sim.source.slice(0, 32) : 'simulated'
    };
}

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

        // Reputation cutoff: admin / manager / auto-unblock sets user.lastUnblockedAt.
        // Rules that look at "recent events" must ignore everything before this stamp,
        // otherwise an unblocked user is immediately re-blocked on their next checkout
        // by the same EventLog rows that caused the original block.
        const userForCutoff = await User.findById(userId).select('lastUnblockedAt').lean();
        const eventCutoff = userForCutoff?.lastUnblockedAt || new Date(0);

        // Fetch recent events for the user to analyze behavior
        const recentEvents = await EventLog.find({ userId, timestamp: { $gte: eventCutoff } })
            .sort({ timestamp: -1 })
            .limit(20); // Look at last 20 events

        let riskScore = 0;
        let action = 'allow';
        let violationReasons = [];
        let geoSpeed = 0;
        let clusterSize = 1;
        let xaiExplanation = null;

        // Tracing scaffolding — every rule/model decision pushes here so the
        // admin Blocked Users page can replay why this evaluation blocked.
        const traceRules = [];
        const traceModels = [];
        let traceLstmProb = 0;
        let traceGnnProb = 0;
        let traceAutoMSE = 0;
        let traceBrainProb = 0;
        let traceR3Gap = null;
        let traceR4Avg = null;
        let traceR5Distance = null;
        let traceR5SpeedKmh = null;

        // Track which "hard" behavioural rules fired so the geo-override can
        // tell whether R5 was the only meaningful signal.
        let hardRuleFired = false;

        // Rule 1: High frequency of add_to_cart (bot-like browsing)
        const addToCartEvents = recentEvents.filter(e => e.eventType === 'add_to_cart');
        if (addToCartEvents.length > 5) {
            // Give 1 risk point for EVERY item they rapidly added to the cart
            riskScore += (addToCartEvents.length * 1);
            violationReasons.push(`High frequency cart additions (${addToCartEvents.length} items)`);
            hardRuleFired = true;
        }

        // Rule 2: Multiple payment failures
        const failedPayments = recentEvents.filter(e => e.eventType === 'payment_failed');
        if (failedPayments.length >= 2) {
            riskScore += 4;
            violationReasons.push("Multiple failed payment attempts");
            hardRuleFired = true;
        }

        // Rule 3: Speed Check: checkout way too fast after login
        const loginEvent = recentEvents.find(e => e.eventType === 'login');
        if (loginEvent) {
            traceR3Gap = (new Date() - new Date(loginEvent.timestamp)) / 1000;
            if (traceR3Gap < 15) {
                // Under 15 seconds from login to checkout
                riskScore += 3;
                violationReasons.push("Unusually fast checkout process");
                hardRuleFired = true;
            }
        }

        // Rule 4: Historical Order Quantity Anomaly (Suspension Rule)
        if (transactionDetails && transactionDetails.items && transactionDetails.items.length > 0) {
            const Order = require('../server/models/Order');
            const pastOrders = await Order.find({ customer: userId, status: { $ne: 'Rejected' } });

            if (pastOrders.length > 0) {
                // Calculate average items per order
                const totalPastItems = pastOrders.reduce((sum, order) => sum + (order.items?.length || 0), 0);
                const avgItemsPerOrder = totalPastItems / pastOrders.length;
                traceR4Avg = avgItemsPerOrder;

                // If they are adding 3x more products than their average (and at least 5 products total to prevent false positives on tiny accounts)
                if (transactionDetails.items.length > (avgItemsPerOrder * 3) && transactionDetails.items.length >= 5) {
                    riskScore += 7; // Massive score to guarantee block
                    violationReasons.push(`Abnormal quantity anomaly. Past Avg: ${Math.round(avgItemsPerOrder)}, Current Cart: ${transactionDetails.items.length}`);
                    hardRuleFired = true;
                    console.log(`[USER FLAGGED] ${userId} exceeded historical item average. OTP required.`);
                }
            }
        }

        // Rule 5: Geospatial Anomaly ("Superman" Check)
        // simulatedLocation (from the cart-page demo picker) overrides IP-based geo
        // when present; otherwise we fall back to the real IP→GeoIP resolution.
        const currentIp = req.body.ipAddress || req.ip;
        const simulatedLocation = normaliseSimulatedLocation(req.body.simulatedLocation);
        const currentLocation = simulatedLocation || resolveGeoIP(currentIp);
        let r5Fired = false; // tracked so the geo-override can downgrade block→OTP later

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
                    traceR5SpeedKmh = speedKmh;
                    traceR5Distance = distanceKm;
                    if (speedKmh > 1000 && distanceKm > 50) {
                        riskScore += 8;
                        r5Fired = true;
                        const fromCity = (lastEventWithLocation.location.city || 'previous location').replace(/ \(Mock\)$/, '');
                        const toCity = currentLocation.city || 'unknown location';
                        const toCountry = currentLocation.country ? `, ${currentLocation.country}` : '';
                        violationReasons.push(`Order placed from a new location — ${toCity}${toCountry} (≈${Math.round(distanceKm)} km from your usual area: ${fromCity})`);
                        console.log(`[GEO ANOMALY] User ${userId} flagged — new location ${toCity} (${Math.round(speedKmh)}km/h, ${Math.round(distanceKm)}km from ${fromCity})`);
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
                traceLstmProb = result.probability || 0;

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
            traceGnnProb = gnnResult.probability || 0;

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
                const amount = transactionDetails.totalAmount || transactionDetails.totalSum || 0;
                const items = transactionDetails.items ? transactionDetails.items.length : 0;
                const hour = now.getHours();
                const day = now.getDay();

                const autoResponse = await axios.post(`${ML_SERVICE_URL}/predict/anomaly`, { 
                    transaction: { amount, items, hour, day } 
                });
                const autoResult = autoResponse.data;
                traceAutoMSE = autoResult.mse || 0;

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
                            hardRuleFired = true;
                        }
                    }
                    
                    if (user && riskScore < 5) {
                        user.lastCheckoutDuration = biometrics.duration;
                        await user.save();
                    }
                }

                // --- FINAL ANN MASTER BRAIN ENSEMBLE ---
                try {
                    const lstmProb = (typeof result !== 'undefined' && result.probability) ? result.probability : 0;
                    const gnnProb = (typeof gnnResult !== 'undefined' && gnnResult.probability) ? gnnResult.probability : 0;
                    const autoMSE = (typeof autoResult !== 'undefined' && autoResult.mse) ? autoResult.mse : 0;
                    
                    // Predict probability
                    const brainResponse = await axios.post(`${ML_SERVICE_URL}/predict/master`, {
                        ensemble_features: { ruleScore: riskScore, lstmProb, gnnProb, autoMSE, geoSpeed, clusterSize }
                    });
                    const brainResult = brainResponse.data;

                    // Get XAI Explanation
                    const explainResponse = await axios.post(`${ML_SERVICE_URL}/predict/explain`, {
                        ensemble_features: { ruleScore: riskScore, lstmProb, gnnProb, autoMSE, geoSpeed, clusterSize }
                    });
                    xaiExplanation = explainResponse.data.explanation;

                    if (brainResult.probability) {
                        const brainProb = brainResult.probability;
                        traceBrainProb = brainProb;
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

        // --- GEO OVERRIDE ----------------------------------------------------
        // If R5 (geo anomaly) is the only "hard" rule that fired, never escalate
        // beyond requires_otp — soft signals like the autoencoder or ANN master
        // brain alone shouldn't auto-block a user just because they shipped from
        // a new city. They should still verify via OTP.
        // --------------------------------------------------------------------
        if (r5Fired && !hardRuleFired) {
            if (riskScore > 8) {
                console.log(`[GEO OVERRIDE] R5 was the only hard rule — downgrading block→requires_otp (was score ${riskScore})`);
                riskScore = Math.min(riskScore, 8); // cap so the action branch below resolves to requires_otp (> 6, ≤ 8)
            }
        }

        if (riskScore > 8) {
            action = 'block';
            try {
                const cooldownMs = Number(process.env.FRAUD_BLOCK_COOLDOWN_MS) || 60000;
                const now = new Date();
                await User.findByIdAndUpdate(userId, {
                    isBlocked: true,
                    blockReason: `Auto-Blocked by System: Risk Score reached ${riskScore}`,
                    blockedAt: now,
                    blockedUntil: new Date(now.getTime() + cooldownMs)
                });
                console.log(`[AUTO-BLOCK] User ${userId} blocked (risk ${riskScore}), cooldown ${cooldownMs}ms.`);
            } catch (e) {
                console.error("Failed to auto-block user:", e);
            }
        } else if (riskScore > 6) {
            action = 'requires_otp';
        } else if (riskScore > 3) {
            action = 'warning';
        }

        // -----------------------------------------------------------------
        // Build the structured decision trace from values captured above.
        // Mirrors the shape used by /api/fraud/inference-debug so the admin
        // Blocked Users details panel can render identical UI.
        // -----------------------------------------------------------------
        try {
            const itemCountArr = Array.isArray(transactionDetails && transactionDetails.items) ? transactionDetails.items : [];
            const totalItems = itemCountArr.length;
            const totalAmt = (transactionDetails && (transactionDetails.totalAmount || transactionDetails.totalSum)) || 0;
            const r4Avg = traceR4Avg == null ? null : +traceR4Avg.toFixed(2);
            const r4Threshold = traceR4Avg == null ? null : +(traceR4Avg * 3).toFixed(2);

            traceRules.push({
                id: 'R1', name: 'High-frequency cart additions', origin: 'fraud-service',
                formula: 'if (addToCartEvents > 5) score += addToCartEvents × 1',
                inputs: { addToCartEvents: addToCartEvents.length },
                fired: addToCartEvents.length > 5,
                points: addToCartEvents.length > 5 ? addToCartEvents.length : 0
            });
            traceRules.push({
                id: 'R2', name: 'Multiple payment failures', origin: 'fraud-service',
                formula: 'if (failedPaymentEvents ≥ 2) score += 4',
                inputs: { failedPayments: failedPayments.length },
                fired: failedPayments.length >= 2,
                points: failedPayments.length >= 2 ? 4 : 0
            });
            traceRules.push({
                id: 'R3', name: 'Fast checkout after login', origin: 'fraud-service',
                formula: 'if (now - lastLogin < 15s) score += 3',
                inputs: { secondsSinceLogin: traceR3Gap === null ? 'no recent login' : +traceR3Gap.toFixed(1) },
                fired: traceR3Gap !== null && traceR3Gap < 15,
                points: (traceR3Gap !== null && traceR3Gap < 15) ? 3 : 0
            });
            traceRules.push({
                id: 'R4', name: 'Historical quantity anomaly', origin: 'fraud-service',
                formula: 'if (items > avgItems × 3 AND items ≥ 5) score += 7',
                inputs: { itemsInCart: totalItems, avgItemsPerOrder: r4Avg, threshold: r4Threshold },
                fired: r4Avg != null && totalItems > (r4Avg * 3) && totalItems >= 5,
                points: (r4Avg != null && totalItems > (r4Avg * 3) && totalItems >= 5) ? 7 : 0
            });
            traceRules.push({
                id: 'R5', name: 'Geospatial "Superman" check', origin: 'fraud-service',
                formula: 'if (speed > 1000 km/h AND distance > 50 km) score += 8',
                inputs: {
                    distanceKm: traceR5Distance == null ? null : +traceR5Distance.toFixed(2),
                    speedKmh: traceR5SpeedKmh == null ? null : +traceR5SpeedKmh.toFixed(2)
                },
                fired: traceR5SpeedKmh != null && traceR5SpeedKmh > 1000 && traceR5Distance > 50,
                points: (traceR5SpeedKmh != null && traceR5SpeedKmh > 1000 && traceR5Distance > 50) ? 8 : 0
            });

            traceModels.push({
                id: 'LSTM', name: 'Deep Learning — Behavioural sequence', endpoint: 'POST /predict/behavioral',
                threshold: 0.85, points: 5,
                fired: traceLstmProb > 0.85,
                output: { probability: traceLstmProb },
                transformation: [
                    'Last 10 events from EventLog → integer sequence',
                    'Pad/truncate to length 10, reshape (1,10,1)',
                    'LSTM(64) → Dropout → Dense(32) → sigmoid'
                ]
            });
            traceModels.push({
                id: 'GNN', name: 'Graph Neural Network — fraud ring', endpoint: 'POST /predict/ring',
                threshold: 0.85, points: 6,
                fired: traceGnnProb > 0.85,
                output: { probability: traceGnnProb },
                transformation: [
                    'userId → node_map.json index',
                    'Returns 0 if user not in graph',
                    'GCN(adj, features) → sigmoid'
                ]
            });
            traceModels.push({
                id: 'AE', name: 'Autoencoder — unsupervised anomaly', endpoint: 'POST /predict/anomaly',
                threshold: 2.5, points: 4,
                fired: traceAutoMSE > 2.5,
                output: { mse: traceAutoMSE, is_anomaly: traceAutoMSE > 2.5 },
                transformation: [
                    'Build [amount, items, hour, day] vector',
                    'StandardScaler.transform',
                    'autoencoder.predict → MSE = mean((scaled - reconstructed)²)',
                    'is_anomaly = MSE > 2.5'
                ]
            });
            traceModels.push({
                id: 'ANN', name: 'ANN Master Brain (ensemble)', endpoint: 'POST /predict/master',
                threshold: 0.9, points: null,
                fired: traceBrainProb > 0.9,
                output: { probability: traceBrainProb },
                note: 'Master brain influences action mapping but does not directly add to riskScore.',
                transformation: [
                    `Build 6-D feature vector [ruleScore, lstmProb, gnnProb, autoMSE, geoSpeed, clusterSize]`,
                    `→ [${riskScore}, ${traceLstmProb.toFixed(4)}, ${traceGnnProb.toFixed(4)}, ${traceAutoMSE.toFixed(2)}, ${(geoSpeed || 0).toFixed(2)}, ${clusterSize}]`,
                    'Dense(16,relu) → Dropout → Dense(8,relu) → sigmoid',
                    'If probability > 0.9 → action escalates to requires_otp'
                ]
            });

            const cappedScore = Math.min(10, riskScore);
            const flowSteps = [
                { label: 'Order received', detail: `userId=${userId}`, fired: true, kind: 'start' },
                ...traceRules.map(r => ({
                    label: `[${r.id}] ${r.name}`,
                    detail: r.fired ? `FIRED → +${r.points || 0}` : 'not fired',
                    fired: r.fired,
                    kind: 'rule'
                })),
                ...traceModels.map(m => ({
                    label: `[${m.id}] ${m.name}`,
                    detail: m.fired ? `FIRED${m.points ? ' → +' + m.points : ' (escalate)'}` : 'not fired',
                    fired: m.fired,
                    kind: 'model'
                })),
                { label: `Risk score = ${cappedScore} / 10`, detail: cappedScore > 8 ? 'block path' : cappedScore > 6 ? 'OTP path' : cappedScore > 3 ? 'warning path' : 'allow path', fired: true, kind: 'aggregate' },
                { label: `Final action: ${String(action).toUpperCase()}`, detail: action === 'block' ? 'user auto-blocked + cooldown started' : action, fired: action !== 'allow', kind: 'final' }
            ];

            var __decisionTrace = {
                rules: traceRules,
                models: traceModels,
                aggregate: {
                    riskScore: cappedScore,
                    rawSum: riskScore,
                    action,
                    reasons: violationReasons.slice(),
                    explanation: xaiExplanation || null
                },
                flow: flowSteps,
                simulatedOrder: {
                    items: (transactionDetails && transactionDetails.items) || [],
                    totalAmount: (transactionDetails && (transactionDetails.totalAmount || transactionDetails.totalSum)) || 0,
                    paymentMethod: (transactionDetails && transactionDetails.paymentMethod) || 'unknown'
                },
                context: {
                    recentEventCount: recentEvents.length,
                    recentEventTypes: recentEvents.map(e => e.eventType),
                    currentLocation,
                    simulatedLocation: simulatedLocation || null
                },
                evaluatedAt: new Date()
            };
        } catch (traceError) {
            console.error('[TRACE BUILD ERROR]', traceError.message);
            var __decisionTrace = null;
        }

        // ALWAYS save/log the fraud alert so the manager can see the risk score
        const alert = new FraudAlert({
            userId,
            transactionId: `TXN-${Date.now()}`,
            riskScore,
            violationReason: violationReasons.length > 0 ? violationReasons.join(' | ') : 'No anomalies detected',
            status: riskScore > 6 ? 'Pending' : 'Resolved', // Auto-resolve low-risk scores
            explanation: xaiExplanation, // Store local feature attribution (SHAP-like data)
            decisionTrace: __decisionTrace,
            action
        });
        await alert.save();

        console.log(`[EVALUATION] User: ${userId}, Score: ${riskScore}, Action: ${action}`);
        res.status(200).json({ riskScore, action, reasons: violationReasons, explanation: xaiExplanation });
    } catch (error) {
        console.error('Evaluate transaction error:', error);
        res.status(500).json({ error: error.message });
    }
});

// =====================================================================
// Inference Debug Endpoint — drives the admin Inference Playground.
// Read-only: no FraudAlert saved, no User mutated. Returns a per-rule
// and per-model breakdown so the UI can show input → transformation →
// output for each component.
// =====================================================================
app.post('/api/fraud/inference-debug', async (req, res) => {
    try {
        const { customerId, simulatedOrder = {} } = req.body || {};
        if (!customerId) return res.status(400).json({ error: 'customerId required' });

        const Order = require('../server/models/Order');
        const customer = await User.findById(customerId).select('username email role lastUnblockedAt');
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const EVENT_MAP = {
            login: 1, add_to_cart: 2, remove_from_cart: 3,
            checkout_attempt: 4, payment_failed: 5, payment_success: 6
        };

        const items = Array.isArray(simulatedOrder.items) ? simulatedOrder.items : [];
        const totalAmount = Number(simulatedOrder.totalAmount) || 0;
        const paymentMethod = simulatedOrder.paymentMethod || 'COD';

        // Same reputation cutoff as /evaluate-transaction so inference-debug
        // replays match what the live evaluator would see.
        const eventCutoff = customer.lastUnblockedAt || new Date(0);
        const recentEvents = await EventLog.find({ userId: customerId, timestamp: { $gte: eventCutoff } })
            .sort({ timestamp: -1 })
            .limit(20)
            .lean();

        const pastOrders = await Order.find({ customer: customerId, status: { $ne: 'Rejected' } }).lean();
        const totalPastItems = pastOrders.reduce((s, o) => s + ((o.items && o.items.length) || 0), 0);
        const avgItemsPerOrder = pastOrders.length ? totalPastItems / pastOrders.length : 3;
        const totalPastAmount = pastOrders.reduce((s, o) => s + (o.totalAmount || 0), 0);
        const avgAmountPerOrder = pastOrders.length ? totalPastAmount / pastOrders.length : 0;

        const rules = [];
        const models = [];
        let riskScore = 0;

        // ---- Server-side velocity rules (mirroring orders.js) ----
        const QTY_SPIKE_MULT = 3;
        const AMT_SPIKE_MULT = 5;
        const QTY_NOISE_FLOOR = 5;
        const STATIC_HIGH_VALUE = 50000;
        const currentItemTotalQty = items.reduce((s, it) => s + (Number(it.quantity) || 1), 0);
        const qtyLimit = Math.max(avgItemsPerOrder * QTY_SPIKE_MULT, QTY_NOISE_FLOOR);
        const amtLimit = avgAmountPerOrder * AMT_SPIKE_MULT;

        rules.push({
            id: 'SV1',
            name: 'Server velocity — quantity spike',
            origin: 'server (orders.js)',
            formula: `currentQty > max(avgQty × ${QTY_SPIKE_MULT}, ${QTY_NOISE_FLOOR})`,
            inputs: { currentQty: currentItemTotalQty, avgQty: +avgItemsPerOrder.toFixed(2), threshold: +qtyLimit.toFixed(2) },
            fired: currentItemTotalQty > qtyLimit,
            triggers: 'requires_otp + spikeAlert (server-side, before fraud-service is called)',
            note: 'This rule short-circuits to OTP at the server before fraud-service runs.'
        });
        rules.push({
            id: 'SV2',
            name: 'Server velocity — high-value transaction',
            origin: 'server (orders.js)',
            formula: `totalAmount > ₹${STATIC_HIGH_VALUE.toLocaleString('en-IN')}`,
            inputs: { totalAmount, threshold: STATIC_HIGH_VALUE },
            fired: totalAmount > STATIC_HIGH_VALUE,
            triggers: 'requires_otp'
        });
        rules.push({
            id: 'SV3',
            name: 'Server velocity — amount spike',
            origin: 'server (orders.js)',
            formula: `totalAmount > avgAmount × ${AMT_SPIKE_MULT}`,
            inputs: { totalAmount, avgAmount: Math.round(avgAmountPerOrder), threshold: Math.round(amtLimit) },
            fired: totalAmount > amtLimit && totalAmount <= STATIC_HIGH_VALUE && currentItemTotalQty <= qtyLimit,
            triggers: 'requires_otp'
        });

        // ---- Fraud-service rules ----
        const addToCartEvents = recentEvents.filter(e => e.eventType === 'add_to_cart');
        const failedPayments = recentEvents.filter(e => e.eventType === 'payment_failed');
        const loginEvent = recentEvents.find(e => e.eventType === 'login');

        const r1Fired = addToCartEvents.length > 5;
        const r1Pts = r1Fired ? addToCartEvents.length * 1 : 0;
        if (r1Fired) riskScore += r1Pts;
        rules.push({
            id: 'R1',
            name: 'High-frequency cart additions',
            origin: 'fraud-service',
            formula: 'if (addToCartEvents > 5) score += addToCartEvents × 1',
            inputs: { addToCartEvents: addToCartEvents.length },
            fired: r1Fired,
            points: r1Pts
        });

        const r2Fired = failedPayments.length >= 2;
        const r2Pts = r2Fired ? 4 : 0;
        if (r2Fired) riskScore += r2Pts;
        rules.push({
            id: 'R2',
            name: 'Multiple payment failures',
            origin: 'fraud-service',
            formula: 'if (failedPaymentEvents ≥ 2) score += 4',
            inputs: { failedPayments: failedPayments.length },
            fired: r2Fired,
            points: r2Pts
        });

        let r3Fired = false, r3Pts = 0, r3Gap = null;
        if (loginEvent) {
            r3Gap = (Date.now() - new Date(loginEvent.timestamp).getTime()) / 1000;
            r3Fired = r3Gap < 15;
            r3Pts = r3Fired ? 3 : 0;
            if (r3Fired) riskScore += r3Pts;
        }
        rules.push({
            id: 'R3',
            name: 'Fast checkout after login',
            origin: 'fraud-service',
            formula: 'if (now - lastLogin < 15s) score += 3',
            inputs: { secondsSinceLogin: r3Gap === null ? 'no recent login' : +r3Gap.toFixed(1) },
            fired: r3Fired,
            points: r3Pts
        });

        const r4Fired = items.length > avgItemsPerOrder * 3 && items.length >= 5;
        const r4Pts = r4Fired ? 7 : 0;
        if (r4Fired) riskScore += r4Pts;
        rules.push({
            id: 'R4',
            name: 'Historical quantity anomaly',
            origin: 'fraud-service',
            formula: 'if (items > avgItems × 3 AND items ≥ 5) score += 7',
            inputs: { itemsInCart: items.length, avgItemsPerOrder: +avgItemsPerOrder.toFixed(2), threshold: +(avgItemsPerOrder * 3).toFixed(2) },
            fired: r4Fired,
            points: r4Pts
        });

        // R5 — Superman check. If the caller passes simulatedLocation we can
        // compute the real distance/speed against the user's last event with a
        // known location. Without simulatedLocation we keep the original stub
        // behaviour (no current-IP timeline available in the playground).
        const dbgSimulatedLocation = normaliseSimulatedLocation(simulatedOrder.simulatedLocation);
        let r5Fired = false, r5Pts = 0;
        let r5Inputs = { note: 'Skipped — provide simulatedLocation in the request to run.' };
        if (dbgSimulatedLocation) {
            const lastEventWithLocation = recentEvents.find(e => e.location && e.location.lat);
            if (lastEventWithLocation) {
                const distanceKm = calculateDistance(
                    lastEventWithLocation.location.lat,
                    lastEventWithLocation.location.lon,
                    dbgSimulatedLocation.lat,
                    dbgSimulatedLocation.lon
                );
                const timeDiffHours = Math.max(
                    (Date.now() - new Date(lastEventWithLocation.timestamp).getTime()) / 3600000,
                    1 / 3600 // never divide by zero — clamp to 1s minimum
                );
                const speedKmh = distanceKm / timeDiffHours;
                r5Fired = speedKmh > 1000 && distanceKm > 50;
                r5Pts = r5Fired ? 8 : 0;
                if (r5Fired) riskScore += r5Pts;
                r5Inputs = {
                    distanceKm: +distanceKm.toFixed(1),
                    speedKmh: +speedKmh.toFixed(1),
                    from: { lat: lastEventWithLocation.location.lat, lon: lastEventWithLocation.location.lon, city: lastEventWithLocation.location.city || '?' },
                    to: { lat: dbgSimulatedLocation.lat, lon: dbgSimulatedLocation.lon, city: dbgSimulatedLocation.city }
                };
            } else {
                r5Inputs = { note: 'simulatedLocation provided but user has no prior event with a known location → cannot compute speed.' };
            }
        }
        rules.push({
            id: 'R5',
            name: 'Geospatial "Superman" check',
            origin: 'fraud-service',
            formula: 'if (speed > 1000 km/h AND distance > 50 km) score += 8',
            inputs: r5Inputs,
            fired: r5Fired,
            points: r5Pts
        });

        // ---- Model: LSTM behavioural sequence ----
        const recent10 = recentEvents.slice(0, 10);
        const eventTypeArr = recent10.map(e => e.eventType);
        const sequenceIds = recent10.map(e => EVENT_MAP[e.eventType] || 0).reverse();
        const lstmTransformation = [
            `Step 1: EventLog.find({ userId, timestamp >= ${customer.lastUnblockedAt ? new Date(customer.lastUnblockedAt).toISOString() : 'epoch'} }).sort({ timestamp: -1 }).limit(20)  →  ${recentEvents.length} events`,
            `Step 2: take .slice(0, 10)  →  ${recent10.length} events`,
            `Step 3: map eventType → integer using EVENT_MAP {login=1, add_to_cart=2, remove_from_cart=3, checkout_attempt=4, payment_failed=5, payment_success=6}`,
            `Step 4: eventTypes  =  ${JSON.stringify(eventTypeArr)}`,
            `Step 5: integers   =  ${JSON.stringify(recent10.map(e => EVENT_MAP[e.eventType] || 0))}`,
            `Step 6: .reverse() to chronological order  →  ${JSON.stringify(sequenceIds)}`,
            `Step 7: ML side pads to length 10 (zeros at front) → reshape to (1, 10, 1) → LSTM(64) → sigmoid`
        ];
        let lstmEntry = {
            id: 'LSTM',
            name: 'Deep Learning — Behavioural sequence',
            endpoint: 'POST /predict/behavioral',
            transformation: lstmTransformation,
            input: { sequence: sequenceIds },
            threshold: 0.85,
            points: 5,
            fired: false,
            output: null,
            error: null,
            skipped: recentEvents.length < 5,
            skipReason: recentEvents.length < 5 ? `Only ${recentEvents.length} recent events; rule requires ≥ 5` : null
        };
        if (!lstmEntry.skipped) {
            try {
                const r = await axios.post(`${ML_SERVICE_URL}/predict/behavioral`, { sequence: sequenceIds });
                lstmEntry.output = r.data;
                lstmEntry.fired = r.data.probability > 0.85;
                if (lstmEntry.fired) riskScore += lstmEntry.points;
            } catch (e) { lstmEntry.error = e.message; }
        }
        models.push(lstmEntry);
        const lstmProb = (lstmEntry.output && lstmEntry.output.probability) || 0;

        // ---- Model: GNN ring detection ----
        let gnnEntry = {
            id: 'GNN',
            name: 'Graph Neural Network — fraud ring',
            endpoint: 'POST /predict/ring',
            transformation: [
                `Input is just userId; resolved to a graph node via node_map.json`,
                `If user not in graph (no shared address/phone/device with anyone in node_map.json), returns probability=0`,
                `Otherwise: GCN(adj, features) → sigmoid → probability`
            ],
            input: { userId: customerId },
            threshold: 0.85,
            points: 6,
            fired: false,
            output: null,
            error: null
        };
        try {
            const r = await axios.post(`${ML_SERVICE_URL}/predict/ring`, { userId: customerId });
            gnnEntry.output = r.data;
            gnnEntry.fired = (r.data.probability || 0) > 0.85;
            if (gnnEntry.fired) riskScore += gnnEntry.points;
        } catch (e) { gnnEntry.error = e.message; }
        models.push(gnnEntry);
        const gnnProb = (gnnEntry.output && gnnEntry.output.probability) || 0;

        // ---- Model: Autoencoder unsupervised anomaly ----
        const now = new Date();
        const autoFeatures = {
            amount: totalAmount,
            items: items.length,
            hour: simulatedOrder.hour != null ? Number(simulatedOrder.hour) : now.getHours(),
            day: simulatedOrder.day != null ? Number(simulatedOrder.day) : now.getDay()
        };
        let autoEntry = {
            id: 'AE',
            name: 'Autoencoder — unsupervised anomaly',
            endpoint: 'POST /predict/anomaly',
            transformation: [
                `Build 4-D vector [amount, items, hour, day]  →  [${autoFeatures.amount}, ${autoFeatures.items}, ${autoFeatures.hour}, ${autoFeatures.day}]`,
                `scaler.transform(X)   (StandardScaler from training)`,
                `autoencoder.predict(scaledX)  →  reconstructed`,
                `MSE = mean((scaled - reconstructed)^2)`,
                `is_anomaly  = MSE > threshold(2.5)`
            ],
            input: { transaction: autoFeatures },
            threshold: 2.5,
            points: 4,
            fired: false,
            output: null,
            error: null
        };
        try {
            const r = await axios.post(`${ML_SERVICE_URL}/predict/anomaly`, { transaction: autoFeatures });
            autoEntry.output = r.data;
            autoEntry.fired = !!r.data.is_anomaly;
            if (autoEntry.fired) riskScore += autoEntry.points;
        } catch (e) { autoEntry.error = e.message; }
        models.push(autoEntry);
        const autoMSE = (autoEntry.output && autoEntry.output.mse) || 0;

        // ---- Model: ANN Master Brain + XAI ----
        const ensembleFeatures = { ruleScore: riskScore, lstmProb, gnnProb, autoMSE, geoSpeed: 0, clusterSize: 1 };
        let masterEntry = {
            id: 'ANN',
            name: 'ANN Master Brain (ensemble)',
            endpoint: 'POST /predict/master',
            transformation: [
                `Build 6-D feature vector [ruleScore, lstmProb, gnnProb, autoMSE, geoSpeed, clusterSize]`,
                `→ [${riskScore}, ${lstmProb.toFixed(4)}, ${gnnProb.toFixed(4)}, ${autoMSE.toFixed(2)}, 0, 1]`,
                `ANN(64, relu) → ANN(32, relu) → sigmoid → probability`,
                `If probability > 0.90: action escalates to requires_otp`
            ],
            input: { ensemble_features: ensembleFeatures },
            threshold: 0.90,
            points: null,
            fired: false,
            output: null,
            error: null,
            note: 'Master brain influences action mapping but does not directly add to riskScore.'
        };
        let xaiEntry = {
            id: 'XAI',
            name: 'XAI — feature attribution (SHAP-like perturbation)',
            endpoint: 'POST /predict/explain',
            transformation: [
                `For each of the 6 features: replace value with baseline mean → re-run ANN`,
                `contribution = (full_prob - perturbed_prob) × 10`,
                `Larger positive = pushes towards fraud; negative = pushes away.`
            ],
            input: { ensemble_features: ensembleFeatures },
            output: null,
            error: null,
            fired: false,
            note: 'Explanation only — does not influence the score directly.'
        };
        try {
            const r = await axios.post(`${ML_SERVICE_URL}/predict/master`, { ensemble_features: ensembleFeatures });
            masterEntry.output = r.data;
            masterEntry.fired = (r.data.probability || 0) > 0.9;
        } catch (e) { masterEntry.error = e.message; }
        try {
            const r = await axios.post(`${ML_SERVICE_URL}/predict/explain`, { ensemble_features: ensembleFeatures });
            xaiEntry.output = r.data;
        } catch (e) { xaiEntry.error = e.message; }
        models.push(masterEntry, xaiEntry);

        // ---- Action mapping ----
        const cappedScore = Math.min(10, riskScore);
        let action = 'allow';
        if (cappedScore > 8) action = 'block';
        else if (cappedScore > 6) action = 'requires_otp';
        else if (cappedScore > 3) action = 'warning';
        if (masterEntry.fired) action = 'requires_otp'; // master brain escalation
        if (cappedScore > 8) action = 'block';          // > 8 always wins

        const reasons = []
            .concat(rules.filter(r => r.fired && r.origin === 'server (orders.js)').map(r => `[${r.id}] ${r.name}`))
            .concat(rules.filter(r => r.fired && r.origin === 'fraud-service').map(r => `[${r.id}] ${r.name} (+${r.points})`))
            .concat(models.filter(m => m.fired).map(m => `[${m.id}] ${m.name}${m.points ? ` (+${m.points})` : ''}`));

        res.json({
            customer: { _id: customer._id, username: customer.username, email: customer.email, role: customer.role },
            context: {
                recentEventCount: recentEvents.length,
                recentEventTypes: recentEvents.map(e => e.eventType),
                pastOrderCount: pastOrders.length,
                averageOrderSize: +avgItemsPerOrder.toFixed(2),
                averageOrderAmount: Math.round(avgAmountPerOrder),
                simulatedLocation: dbgSimulatedLocation || null
            },
            simulatedOrder: { items, totalAmount, paymentMethod, ...autoFeatures },
            rules,
            models,
            aggregate: {
                riskScore: cappedScore,
                rawSum: riskScore,
                action,
                reasons,
                explanation: (xaiEntry.output && xaiEntry.output.explanation) || null
            }
        });
    } catch (error) {
        console.error('Inference debug error:', error);
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

// ====================================================================
// Block Detail — drives the admin/manager Blocked Users details panel.
// Returns the most recent FraudAlert that produced action='block' (or
// the most recent alert if none flipped to block, e.g. manual blocks)
// along with its full decisionTrace.
// ====================================================================
app.get('/api/fraud/block-detail/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId) return res.status(400).json({ error: 'userId required' });

        const user = await User.findById(userId).select('username email role isBlocked blockReason blockedAt blockedUntil');
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Prefer the most recent alert that produced a block action; fall
        // back to the most recent alert overall (covers manual blocks and
        // legacy alerts written before decisionTrace existed).
        let alert = await FraudAlert.findOne({ userId, action: 'block' }).sort({ createdAt: -1 }).lean();
        if (!alert) alert = await FraudAlert.findOne({ userId }).sort({ createdAt: -1 }).lean();

        res.json({
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                isBlocked: user.isBlocked,
                blockReason: user.blockReason,
                blockedAt: user.blockedAt,
                blockedUntil: user.blockedUntil
            },
            alert: alert ? {
                _id: alert._id,
                riskScore: alert.riskScore,
                action: alert.action,
                violationReason: alert.violationReason,
                explanation: alert.explanation,
                decisionTrace: alert.decisionTrace,
                status: alert.status,
                createdAt: alert.createdAt
            } : null
        });
    } catch (error) {
        console.error('Block detail error:', error);
        res.status(500).json({ error: error.message });
    }
});

// =====================================================================
// D1 — Fraud Overview Insights
// GET /api/fraud/insights/overview
// Drives the admin Dashboard (#view-dashboard). Returns today/yesterday
// KPIs, 7-day trend, 30-day action mix, and top-5 risky users.
// All aggregations run in Mongo so this stays fast on 1k+ alerts.
// =====================================================================
app.get('/api/fraud/insights/overview', async (req, res) => {
    try {
        const Order = require('../server/models/Order');

        // UTC midnight today + yesterday
        const now = new Date();
        const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000); // include today → 7 buckets
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        // ---- today / yesterday counts (5 parallel counts each window) ----
        const [
            todayEvents, todayOrders, todayAlerts, todayBlocks,
            yEvents, yOrders, yAlerts, yBlocks
        ] = await Promise.all([
            EventLog.countDocuments({ createdAt: { $gte: todayStart } }),
            Order.countDocuments({ createdAt: { $gte: todayStart } }),
            FraudAlert.countDocuments({ createdAt: { $gte: todayStart } }),
            FraudAlert.countDocuments({ createdAt: { $gte: todayStart }, action: 'block' }),
            EventLog.countDocuments({ createdAt: { $gte: yesterdayStart, $lt: todayStart } }),
            Order.countDocuments({ createdAt: { $gte: yesterdayStart, $lt: todayStart } }),
            FraudAlert.countDocuments({ createdAt: { $gte: yesterdayStart, $lt: todayStart } }),
            FraudAlert.countDocuments({ createdAt: { $gte: yesterdayStart, $lt: todayStart }, action: 'block' }),
        ]);

        // ---- 7-day trend: alerts + blocks (FraudAlert) and orders (Order) ----
        const fmt = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } };
        const [alertAgg, orderAgg] = await Promise.all([
            FraudAlert.aggregate([
                { $match: { createdAt: { $gte: sevenDaysAgo } } },
                { $group: {
                    _id: fmt,
                    alerts: { $sum: 1 },
                    blocks: { $sum: { $cond: [{ $eq: ['$action', 'block'] }, 1, 0] } }
                } }
            ]),
            Order.aggregate([
                { $match: { createdAt: { $gte: sevenDaysAgo } } },
                { $group: { _id: fmt, orders: { $sum: 1 } } }
            ])
        ]);
        const alertMap = Object.fromEntries(alertAgg.map(a => [a._id, a]));
        const orderMap = Object.fromEntries(orderAgg.map(o => [o._id, o]));

        const trend7days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
            const key = d.toISOString().slice(0, 10); // YYYY-MM-DD UTC
            const a = alertMap[key] || { alerts: 0, blocks: 0 };
            const o = orderMap[key] || { orders: 0 };
            const denom = Math.max(o.orders, 1);
            trend7days.push({
                date: key,
                alerts: a.alerts,
                orders: o.orders,
                blocks: a.blocks,
                fraudRate: +(a.alerts / denom).toFixed(4)
            });
        }

        // ---- Action mix (last 30 days) ----
        const actionAgg = await FraudAlert.aggregate([
            { $match: { createdAt: { $gte: thirtyDaysAgo } } },
            { $group: { _id: '$action', count: { $sum: 1 } } }
        ]);
        const actionMix = { allow: 0, warning: 0, requires_otp: 0, block: 0 };
        actionAgg.forEach(a => {
            if (a._id && actionMix.hasOwnProperty(a._id)) actionMix[a._id] = a.count;
        });

        // ---- Top 5 risky users (last 30 days) ----
        const topRiskyAgg = await FraudAlert.aggregate([
            { $match: { createdAt: { $gte: thirtyDaysAgo } } },
            { $sort: { createdAt: -1 } },
            { $group: {
                _id: '$userId',
                latestRiskScore: { $first: '$riskScore' },
                alertsCount: { $sum: 1 }
            } },
            { $sort: { latestRiskScore: -1, alertsCount: -1 } },
            { $limit: 5 },
            { $lookup: {
                from: 'users',
                localField: '_id',
                foreignField: '_id',
                as: 'user'
            } },
            { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
            { $project: {
                _id: 1,
                latestRiskScore: 1,
                alertsCount: 1,
                username: '$user.username',
                email: '$user.email',
                isBlocked: '$user.isBlocked',
                blockedUntil: '$user.blockedUntil'
            } }
        ]);
        const topRiskyUsers = topRiskyAgg.filter(u => u.username); // drop orphaned alerts

        res.json({
            today:     { events: todayEvents, orders: todayOrders, alerts: todayAlerts, blocks: todayBlocks },
            yesterday: { events: yEvents,     orders: yOrders,     alerts: yAlerts,     blocks: yBlocks },
            trend7days,
            actionMix,
            topRiskyUsers
        });
    } catch (e) {
        console.error('Insights overview error:', e);
        res.status(500).json({ error: e.message });
    }
});

// =====================================================================
// D2 — Detection Activity Insights
// GET /api/fraud/insights/detection-activity?days=30
// Drives the admin Detection Activity view (#view-detection). Mines the
// decisionTrace blob from FraudAlert to surface per-rule and per-model
// firing rates, a riskScore × ANN-probability scatter, and per-day action
// stacks. Window is clamped to one of [7, 30, 90] days.
// =====================================================================
app.get('/api/fraud/insights/detection-activity', async (req, res) => {
    try {
        // ---- Window validation: clamp to one of [7, 30, 90], default 30 ----
        const allowedWindows = [7, 30, 90];
        let days = parseInt(req.query.days, 10);
        if (!allowedWindows.includes(days)) days = 30;

        const cutoff = new Date(Date.now() - days * 86400e3);
        const alerts = await FraudAlert.find({ createdAt: { $gte: cutoff } }).lean();
        const totalAlerts = alerts.length;

        // ---- Canonical rule + model catalogues (always returned, even if zero) ----
        const CANONICAL_RULES = [
            { id: 'R1',  name: 'High-frequency cart additions' },
            { id: 'R2',  name: 'Multiple payment failures' },
            { id: 'R3',  name: 'Fast checkout after login' },
            { id: 'R4',  name: 'Historical quantity anomaly' },
            { id: 'R5',  name: 'Geospatial Superman' },
            { id: 'R10', name: 'Maniacal checkout speed' },
            { id: 'R11', name: 'Phantom Honeypot trap' }
        ];
        const CANONICAL_MODELS = [
            { id: 'LSTM', name: 'Behavioural sequence',    endpoint: '/predict/behavioral', defaultPoints: 5 },
            { id: 'GNN',  name: 'Fraud ring',              endpoint: '/predict/ring',       defaultPoints: 6 },
            { id: 'AE',   name: 'Autoencoder anomaly',     endpoint: '/predict/anomaly',    defaultPoints: 4 },
            { id: 'ANN',  name: 'Master Brain ensemble',   endpoint: '/predict/master',     defaultPoints: 3 }
        ];

        // ---- Rule firing rate: JS loop over alerts -> tally fired + sum points ----
        const ruleStats = {};
        CANONICAL_RULES.forEach(r => { ruleStats[r.id] = { fired: 0, sumPoints: 0 }; });
        const modelStats = {};
        CANONICAL_MODELS.forEach(m => { modelStats[m.id] = { fired: 0, sumPoints: 0 }; });

        // ---- Scatter source: collect (riskScore, brainProb, action, createdAt) ----
        const scatterAll = [];

        for (const alert of alerts) {
            const trace = alert.decisionTrace || {};
            const rules = Array.isArray(trace.rules) ? trace.rules : [];
            const models = Array.isArray(trace.models) ? trace.models : [];

            for (const r of rules) {
                if (r && r.id && ruleStats[r.id] && r.fired) {
                    ruleStats[r.id].fired += 1;
                    ruleStats[r.id].sumPoints += Number(r.points) || 0;
                }
            }
            for (const m of models) {
                if (m && m.id && modelStats[m.id] && m.fired) {
                    modelStats[m.id].fired += 1;
                    // Some models (e.g. ANN) have points=null; fall back per-model.
                    const canon = CANONICAL_MODELS.find(c => c.id === m.id);
                    const pts = (m.points != null && Number.isFinite(Number(m.points)))
                        ? Number(m.points)
                        : (canon ? canon.defaultPoints : 0);
                    modelStats[m.id].sumPoints += pts;
                }
            }

            // Scatter row — only if ANN probability is available
            const annModel = models.find(m => m && m.id === 'ANN');
            const brainProb = (annModel && annModel.output && typeof annModel.output.probability === 'number')
                ? annModel.output.probability
                : null;
            if (brainProb != null) {
                scatterAll.push({
                    riskScore: Number(alert.riskScore) || 0,
                    brainProb,
                    action: alert.action || 'allow',
                    createdAt: alert.createdAt
                });
            }
        }

        const ruleFiringRate = CANONICAL_RULES.map(r => {
            const s = ruleStats[r.id];
            return {
                id: r.id,
                name: r.name,
                fired: s.fired,
                rate: totalAlerts > 0 ? +(s.fired / totalAlerts).toFixed(4) : 0,
                avgPointsWhenFired: s.fired > 0 ? +(s.sumPoints / s.fired).toFixed(2) : 0
            };
        });

        const modelFiringRate = CANONICAL_MODELS.map(m => {
            const s = modelStats[m.id];
            return {
                id: m.id,
                name: m.name,
                endpoint: m.endpoint,
                fired: s.fired,
                rate: totalAlerts > 0 ? +(s.fired / totalAlerts).toFixed(4) : 0,
                avgPointsWhenFired: s.fired > 0 ? +(s.sumPoints / s.fired).toFixed(2) : m.defaultPoints
            };
        });

        // ---- Scatter: shuffle + slice to <=500 (Fisher-Yates) ----
        let scatter = scatterAll;
        if (scatter.length > 500) {
            for (let i = scatter.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [scatter[i], scatter[j]] = [scatter[j], scatter[i]];
            }
            scatter = scatter.slice(0, 500);
        }

        // ---- Actions by day: aggregation pipeline + zero-fill missing days ----
        const dayAgg = await FraudAlert.aggregate([
            { $match: { createdAt: { $gte: cutoff } } },
            { $group: {
                _id: {
                    date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
                    action: '$action'
                },
                count: { $sum: 1 }
            } }
        ]);
        const dayMap = {};
        dayAgg.forEach(row => {
            const d = row._id.date;
            const a = row._id.action || 'allow';
            if (!dayMap[d]) dayMap[d] = { date: d, allow: 0, warning: 0, requires_otp: 0, block: 0 };
            if (dayMap[d].hasOwnProperty(a)) dayMap[d][a] = row.count;
        });
        // Zero-fill every UTC day in the window so the bar chart never has gaps.
        const actionByDay = [];
        const now = new Date();
        const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(todayStart.getTime() - i * 86400000);
            const key = d.toISOString().slice(0, 10);
            actionByDay.push(dayMap[key] || { date: key, allow: 0, warning: 0, requires_otp: 0, block: 0 });
        }

        res.json({
            windowDays: days,
            totalAlerts,
            ruleFiringRate,
            modelFiringRate,
            scatter,
            actionByDay
        });
    } catch (e) {
        console.error('Insights detection-activity error:', e);
        res.status(500).json({ error: e.message });
    }
});

// =====================================================================
// D3 — Geo & Device Insights
// GET /api/fraud/insights/geo-device?days=7
// Drives the admin Geo & Device view (#view-geo). Surfaces recent
// geo-tagged events, top risky cities, impossible-travel (R5) cases,
// a 7×24 time-of-day heatmap, and devices shared across user accounts.
// Window is clamped to one of [1, 7, 30] days (1 = 24h).
// =====================================================================
app.get('/api/fraud/insights/geo-device', async (req, res) => {
    try {
        // ---- Window validation: clamp to one of [1, 7, 30], default 7 ----
        const allowedWindows = [1, 7, 30];
        let days = parseInt(req.query.days, 10);
        if (!allowedWindows.includes(days)) days = 7;

        const cutoff = new Date(Date.now() - days * 86400e3);

        // ---- Latest risk score per user (within the window) ----
        // Aggregate FraudAlert: sort -createdAt then $group $first riskScore.
        const latestRiskAgg = await FraudAlert.aggregate([
            { $match: { createdAt: { $gte: cutoff } } },
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$userId', latestRiskScore: { $first: '$riskScore' } } }
        ]);
        const latestRiskByUser = {};
        latestRiskAgg.forEach(r => {
            if (r._id) latestRiskByUser[String(r._id)] = Number(r.latestRiskScore) || 0;
        });

        // ---- recentGeoEvents (<= 500) ----
        const rawEvents = await EventLog.find({
            timestamp: { $gte: cutoff },
            'location.lat': { $exists: true }
        })
            .sort({ timestamp: -1 })
            .limit(500)
            .populate('userId', 'username')
            .lean();

        const recentGeoEvents = rawEvents.map(ev => {
            const uid = ev.userId && ev.userId._id ? String(ev.userId._id) : String(ev.userId || '');
            const username = (ev.userId && ev.userId.username) ? ev.userId.username : '';
            const loc = ev.location || {};
            return {
                userId: uid,
                username,
                eventType: ev.eventType,
                lat: loc.lat,
                lon: loc.lon,
                city: loc.city || '',
                country: loc.country || '',
                timestamp: ev.timestamp,
                latestRiskScore: latestRiskByUser[uid] || 0
            };
        });

        // ---- topRiskyCities (top 15) ----
        // Aggregate events grouped by {city, country}; events count.
        // avgRisk = mean of latestRiskScore across the distinct users whose
        // events landed in that city this window (pragmatic — does not weight
        // by event volume per user, but stays cheap and intuitive).
        const cityAgg = await EventLog.aggregate([
            {
                $match: {
                    timestamp: { $gte: cutoff },
                    'location.city': { $exists: true, $ne: null, $ne: '' }
                }
            },
            {
                $group: {
                    _id: { city: '$location.city', country: '$location.country' },
                    events: { $sum: 1 },
                    users: { $addToSet: '$userId' }
                }
            },
            { $sort: { events: -1 } },
            { $limit: 15 }
        ]);

        const topRiskyCities = cityAgg.map(c => {
            const users = Array.isArray(c.users) ? c.users : [];
            let sum = 0, n = 0;
            users.forEach(u => {
                const r = latestRiskByUser[String(u)];
                if (typeof r === 'number') { sum += r; n += 1; }
            });
            return {
                city: c._id.city,
                country: c._id.country || '',
                events: c.events,
                avgRisk: n > 0 ? +(sum / n).toFixed(2) : 0
            };
        });

        // ---- impossibleTravel (R5) ----
        const r5Alerts = await FraudAlert.find({
            createdAt: { $gte: cutoff },
            'decisionTrace.rules': { $elemMatch: { id: 'R5', fired: true } }
        })
            .sort({ createdAt: -1 })
            .limit(50)
            .populate('userId', 'username')
            .lean();

        // Pre-fetch geo events per user (for fast 2-event lookup pre-alert).
        const r5UserIds = [...new Set(r5Alerts.map(a => String(a.userId && a.userId._id ? a.userId._id : a.userId)))];
        const userGeoEvents = {};
        if (r5UserIds.length > 0) {
            const geos = await EventLog.find({
                userId: { $in: r5UserIds },
                'location.lat': { $exists: true }
            })
                .sort({ timestamp: -1 })
                .limit(r5UserIds.length * 20)
                .lean();
            geos.forEach(g => {
                const uid = String(g.userId);
                if (!userGeoEvents[uid]) userGeoEvents[uid] = [];
                userGeoEvents[uid].push(g);
            });
        }

        // Fallback city pool for synthetic-only seeds (used only when the
        // two pre-alert events can't be resolved).
        const FALLBACK_CITY_POOL = [
            { city: 'Bengaluru', country: 'IN', lat: 12.9716, lon: 77.5946 },
            { city: 'Mumbai',    country: 'IN', lat: 19.0760, lon: 72.8777 },
            { city: 'Delhi',     country: 'IN', lat: 28.6139, lon: 77.2090 },
            { city: 'Dubai',     country: 'AE', lat: 25.2048, lon: 55.2708 },
            { city: 'Singapore', country: 'SG', lat: 1.3521,  lon: 103.8198 },
            { city: 'London',    country: 'GB', lat: 51.5074, lon: -0.1278 },
            { city: 'New York',  country: 'US', lat: 40.7128, lon: -74.0060 }
        ];

        const impossibleTravel = r5Alerts.map(alert => {
            const uid = String(alert.userId && alert.userId._id ? alert.userId._id : alert.userId);
            const username = (alert.userId && alert.userId.username) ? alert.userId.username : '';
            const alertAt = alert.createdAt;

            // Look up the two most-recent geo events BEFORE the alert.
            const userEvents = (userGeoEvents[uid] || [])
                .filter(g => g.location && typeof g.location.lat === 'number' && typeof g.location.lon === 'number')
                .filter(g => new Date(g.timestamp) <= new Date(alertAt))
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            let fromEv, toEv;
            if (userEvents.length >= 2) {
                toEv = userEvents[0];       // newer (more recent before the alert)
                fromEv = userEvents[1];     // older
            } else {
                // Fallback: random two cities so the UI always has data.
                const a = FALLBACK_CITY_POOL[Math.floor(Math.random() * FALLBACK_CITY_POOL.length)];
                let b = FALLBACK_CITY_POOL[Math.floor(Math.random() * FALLBACK_CITY_POOL.length)];
                if (b.city === a.city) b = FALLBACK_CITY_POOL[(FALLBACK_CITY_POOL.indexOf(a) + 1) % FALLBACK_CITY_POOL.length];
                fromEv = { location: a, timestamp: new Date(new Date(alertAt).getTime() - 3600e3) };
                toEv   = { location: b, timestamp: alertAt };
            }

            return {
                alertId: String(alert._id),
                userId: uid,
                username,
                speedKmh: Number(alert.traceR5SpeedKmh) || 0,
                distanceKm: Number(alert.traceR5DistanceKm) || 0,
                fromCity: (fromEv.location && fromEv.location.city) || '',
                toCity:   (toEv.location   && toEv.location.city)   || '',
                fromLat: fromEv.location.lat,
                fromLon: fromEv.location.lon,
                toLat:   toEv.location.lat,
                toLon:   toEv.location.lon,
                fromAt:  fromEv.timestamp,
                toAt:    toEv.timestamp
            };
        });

        // ---- todHeatmap (7×24 = 168 entries) ----
        // $dayOfWeek returns 1..7 (Sun=1). Convert to 0..6 (Sun=0) downstream.
        const [eventTodAgg, alertTodAgg] = await Promise.all([
            EventLog.aggregate([
                { $match: { timestamp: { $gte: cutoff } } },
                {
                    $group: {
                        _id: {
                            dow:  { $dayOfWeek: '$timestamp' },
                            hour: { $hour: '$timestamp' }
                        },
                        events: { $sum: 1 }
                    }
                }
            ]),
            FraudAlert.aggregate([
                { $match: { createdAt: { $gte: cutoff } } },
                {
                    $group: {
                        _id: {
                            dow:  { $dayOfWeek: '$createdAt' },
                            hour: { $hour: '$createdAt' }
                        },
                        alerts: { $sum: 1 }
                    }
                }
            ])
        ]);

        const evMap = {};
        eventTodAgg.forEach(r => {
            const dow = ((r._id.dow || 1) - 1) % 7;
            const hour = r._id.hour || 0;
            evMap[`${dow}-${hour}`] = r.events;
        });
        const alMap = {};
        alertTodAgg.forEach(r => {
            const dow = ((r._id.dow || 1) - 1) % 7;
            const hour = r._id.hour || 0;
            alMap[`${dow}-${hour}`] = r.alerts;
        });
        const todHeatmap = [];
        for (let dow = 0; dow < 7; dow++) {
            for (let hour = 0; hour < 24; hour++) {
                const key = `${dow}-${hour}`;
                todHeatmap.push({
                    dow,
                    hour,
                    events: evMap[key] || 0,
                    alerts: alMap[key] || 0
                });
            }
        }

        // ---- sharedDevices ----
        const sharedAgg = await User.aggregate([
            { $match: { deviceFingerprint: { $ne: null, $ne: '' } } },
            {
                $group: {
                    _id: '$deviceFingerprint',
                    users: { $push: { _id: '$_id', username: '$username', email: '$email', isBlocked: '$isBlocked' } },
                    userCount: { $sum: 1 }
                }
            },
            { $match: { userCount: { $gte: 2 }, _id: { $ne: null } } },
            { $sort: { userCount: -1 } },
            { $limit: 20 }
        ]);

        const sharedDevices = sharedAgg.map(d => {
            const fp = d._id || '';
            const fpShort = fp.length > 12 ? `${fp.slice(0, 12)}…` : fp;
            const anyBlocked = (d.users || []).some(u => !!u.isBlocked);
            return {
                deviceFingerprint: fp,
                fingerprintShort: fpShort,
                userCount: d.userCount,
                users: d.users || [],
                anyBlocked
            };
        });

        res.json({
            windowDays: days,
            recentGeoEvents,
            topRiskyCities,
            impossibleTravel,
            todHeatmap,
            sharedDevices
        });
    } catch (e) {
        console.error('Insights geo-device error:', e);
        res.status(500).json({ error: e.message });
    }
});

// =====================================================================
// D4 — Fraud Ring Graph
// GET /api/fraud/insights/graph?minRisk=0&days=all
// Drives the admin Fraud Ring view (#view-ring). Returns a user-user
// relationship graph: nodes = users (with latest risk + isBlocked),
// edges = pairs of users sharing a phoneNumber, address, or
// deviceFingerprint. Includes per-node clusterSize via union-find and
// aggregate stats (componentCount, largestComponent).
//
// Rings are typically a function of static user attributes, so we do
// not date-filter the graph itself; `?days` is accepted for API
// symmetry with D2/D3 but currently ignored. `minRisk` is applied
// client- and server-side (filtering nodes below threshold and any
// edge that loses an endpoint).
//
// Caps: 1000 nodes (ranked by latestRiskScore desc), 2000 edges
// (ranked by sum of endpoint risk desc). Cheap on 1k+ users.
// =====================================================================
app.get('/api/fraud/insights/graph', async (req, res) => {
    try {
        const minRisk = Math.max(0, Math.min(10, parseInt(req.query.minRisk, 10) || 0));
        // `days` is accepted but currently ignored — rings are static-attribute based.
        // const allowedWindows = ['all', '7', '30', '90'];
        // const days = allowedWindows.includes(req.query.days) ? req.query.days : 'all';

        // ---- Latest risk score per user (all time) ----
        const latestRiskAgg = await FraudAlert.aggregate([
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$userId', latestRiskScore: { $first: '$riskScore' } } }
        ]);
        const latestRiskByUser = {};
        latestRiskAgg.forEach(r => {
            if (r._id) latestRiskByUser[String(r._id)] = Number(r.latestRiskScore) || 0;
        });

        // ---- Pull candidate users ----
        // Include every synthetic user (so seeded rings show up) plus any
        // non-synthetic user that has at least one FraudAlert (riskScore > 0).
        // Cap at 1000 by riskScore desc.
        const riskyUserIds = Object.keys(latestRiskByUser).filter(uid => latestRiskByUser[uid] > 0);
        const userFilter = {
            $or: [
                { synthetic: true },
                { _id: { $in: riskyUserIds } }
            ]
        };
        const rawUsers = await User.find(userFilter)
            .select('username email phoneNumber address deviceFingerprint isBlocked synthetic')
            .lean();

        // Sort by risk desc then cap to 1000.
        rawUsers.sort((a, b) => (latestRiskByUser[String(b._id)] || 0) - (latestRiskByUser[String(a._id)] || 0));
        const cappedUsers = rawUsers.slice(0, 1000);

        // Build node lookup keyed by id string.
        const nodeMap = {};
        cappedUsers.forEach(u => {
            const id = String(u._id);
            nodeMap[id] = {
                id,
                username: u.username || '',
                email: u.email || '',
                riskScore: latestRiskByUser[id] || 0,
                isBlocked: !!u.isBlocked,
                clusterSize: 1, // populated by union-find later
                _phone: u.phoneNumber || null,
                _address: u.address || null,
                _device: u.deviceFingerprint || null
            };
        });

        // ---- Compute edges by bucket-then-pair (O(N) buckets, O(K^2) per bucket) ----
        const buckets = { phone: {}, address: {}, device: {} };
        Object.values(nodeMap).forEach(n => {
            if (n._phone)   { (buckets.phone[n._phone]   = buckets.phone[n._phone]   || []).push(n.id); }
            if (n._address) { (buckets.address[n._address] = buckets.address[n._address] || []).push(n.id); }
            if (n._device)  { (buckets.device[n._device]  = buckets.device[n._device]  || []).push(n.id); }
        });

        const edgeKey = (a, b, via) => {
            const [x, y] = a < b ? [a, b] : [b, a];
            return `${x}|${y}|${via}`;
        };
        const edgesSeen = new Set();
        let allEdges = [];

        const emitEdgesForBucket = (bucketObj, sharedVia) => {
            Object.values(bucketObj).forEach(ids => {
                if (!ids || ids.length < 2) return;
                // Cap pairwise blow-up at large buckets (e.g. shared null/'' shouldn't
                // happen because we filtered, but still guard).
                if (ids.length > 50) return;
                for (let i = 0; i < ids.length; i++) {
                    for (let j = i + 1; j < ids.length; j++) {
                        const a = ids[i], b = ids[j];
                        if (a === b) continue;
                        const k = edgeKey(a, b, sharedVia);
                        if (edgesSeen.has(k)) continue;
                        edgesSeen.add(k);
                        allEdges.push({ source: a, target: b, sharedVia });
                    }
                }
            });
        };
        emitEdgesForBucket(buckets.phone, 'phone');
        emitEdgesForBucket(buckets.address, 'address');
        emitEdgesForBucket(buckets.device, 'device');

        // ---- Filter nodes by minRisk; drop edges whose endpoint was filtered ----
        let nodes = Object.values(nodeMap).filter(n => n.riskScore >= minRisk);
        const aliveSet = new Set(nodes.map(n => n.id));
        let edges = allEdges.filter(e => aliveSet.has(e.source) && aliveSet.has(e.target));

        // ---- Cap edges at 2000 (sum-of-endpoint-risk desc) ----
        if (edges.length > 2000) {
            const riskOf = (id) => (nodeMap[id] && nodeMap[id].riskScore) || 0;
            edges.sort((a, b) => (riskOf(b.source) + riskOf(b.target)) - (riskOf(a.source) + riskOf(a.target)));
            edges = edges.slice(0, 2000);
        }

        // ---- Union-find over (filtered) edges to compute cluster sizes ----
        const parent = {};
        const rank = {};
        const findRoot = (x) => {
            while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        };
        const union = (x, y) => {
            const rx = findRoot(x), ry = findRoot(y);
            if (rx === ry) return;
            if (rank[rx] < rank[ry]) parent[rx] = ry;
            else if (rank[rx] > rank[ry]) parent[ry] = rx;
            else { parent[ry] = rx; rank[rx] += 1; }
        };
        nodes.forEach(n => { parent[n.id] = n.id; rank[n.id] = 0; });
        edges.forEach(e => union(e.source, e.target));

        // Count cluster sizes.
        const compSize = {};
        nodes.forEach(n => {
            const r = findRoot(n.id);
            compSize[r] = (compSize[r] || 0) + 1;
        });
        nodes.forEach(n => { n.clusterSize = compSize[findRoot(n.id)] || 1; });

        // ---- Stats ----
        // Only count components with >= 2 nodes for componentCount/largestComponent —
        // singleton nodes aren't really "rings".
        const sizes = Object.values(compSize).filter(s => s >= 2);
        const componentCount = sizes.length;
        const largestComponent = sizes.length > 0 ? Math.max(...sizes) : 0;

        // Strip private underscore fields before returning.
        const publicNodes = nodes.map(n => ({
            id: n.id,
            username: n.username,
            email: n.email,
            riskScore: n.riskScore,
            isBlocked: n.isBlocked,
            clusterSize: n.clusterSize
        }));

        res.json({
            nodes: publicNodes,
            edges,
            stats: {
                totalNodes: publicNodes.length,
                totalEdges: edges.length,
                componentCount,
                largestComponent
            }
        });
    } catch (e) {
        console.error('Insights graph error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`🛡️  Fraud Detection Service running on http://localhost:${PORT}`);
});
