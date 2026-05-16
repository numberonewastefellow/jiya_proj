/**
 * Synthetic seed-data generator for TrackEasy admin dashboards (D1–D4).
 *
 * Produces 500–2000 back-dated records (Users, FraudAlerts, EventLogs, Orders)
 * tagged with synthetic:true so they can be cleared independently of the CSV
 * demo fixtures. The generator is pure JS (no external HTTP) and uses
 * Model.insertMany({ ordered:false }) in batches of 500.
 *
 * Public API:
 *   const { generate, PRESETS } = require('./seedSynthetic');
 *   const result = await generate(PRESETS.medium);
 *   // result = { created: { users, alerts, events, orders, rings }, durationMs }
 *
 * All records carry { synthetic: true } and are spread across `daysBack` days
 * with a realistic daily curve (sine-ish 9–21h peak, weekend dip, an "attack
 * day" 2–3 days ago with 3× alerts and 5× block rate). Fraud rings share a
 * field (phone / address / device) across N users so the upcoming
 * Detection/Forensics dashboards have something to cluster on.
 */

const bcrypt = require('bcryptjs');

const User = require('../models/User');
const FraudAlert = require('../models/FraudAlert');
const EventLog = require('../models/EventLog');
const Order = require('../models/Order');

// ---------------------------------------------------------------------------
// Static config
// ---------------------------------------------------------------------------

const CITIES = [
    { city: 'Bengaluru', country: 'IN', lat: 12.9716, lon: 77.5946 },
    { city: 'Mumbai', country: 'IN', lat: 19.0760, lon: 72.8777 },
    { city: 'Dubai', country: 'AE', lat: 25.2048, lon: 55.2708 },
    { city: 'Singapore', country: 'SG', lat: 1.3521, lon: 103.8198 },
    { city: 'London', country: 'GB', lat: 51.5074, lon: -0.1278 },
    { city: 'New York', country: 'US', lat: 40.7128, lon: -74.0060 },
    { city: 'Berlin', country: 'DE', lat: 52.5200, lon: 13.4050 },
    { city: 'Tokyo', country: 'JP', lat: 35.6762, lon: 139.6503 },
    { city: 'Sydney', country: 'AU', lat: -33.8688, lon: 151.2093 },
    { city: 'São Paulo', country: 'BR', lat: -23.5505, lon: -46.6333 },
    { city: 'Lagos', country: 'NG', lat: 6.5244, lon: 3.3792 },
    { city: 'Riyadh', country: 'SA', lat: 24.7136, lon: 46.6753 },
];

const DEVICE_POOL = Array.from({ length: 8 }, (_, i) => `synth_dev_${i + 1}`);

const RULE_DEFS = [
    { id: 'R1', name: 'R1 cart velocity', prob: 0.30, points: () => 1 + Math.floor(Math.random() * 5) },
    { id: 'R2', name: 'R2 payment fails', prob: 0.20, points: () => 4 },
    { id: 'R3', name: 'R3 fast checkout', prob: 0.15, points: () => 3 },
    { id: 'R4', name: 'R4 qty anomaly', prob: 0.12, points: () => 7 },
    { id: 'R5', name: 'R5 geo Superman', prob: 0.08, points: () => 8 },
    { id: 'R10', name: 'R10 maniacal speed', prob: 0.05, points: () => 10 },
    { id: 'R11', name: 'R11 honeypot', prob: 0.02, points: () => 20 },
];

const MODEL_DEFS = [
    { id: 'LSTM', name: 'Behavioral LSTM', endpoint: '/predict/behavioral', key: 'probability' },
    { id: 'GNN', name: 'Graph Neural Network', endpoint: '/predict/graph', key: 'probability' },
    { id: 'AE', name: 'Autoencoder', endpoint: '/predict/autoencoder', key: 'mse' },
    { id: 'ANN', name: 'Master ANN', endpoint: '/predict/master', key: 'probability' },
];

const EVENT_DISTRIBUTION = [
    { type: 'login', p: 0.30 },
    { type: 'add_to_cart', p: 0.35 },
    { type: 'checkout_attempt', p: 0.10 },
    { type: 'payment_attempt', p: 0.08 },
    { type: 'payment_success', p: 0.12 },
    { type: 'payment_failed', p: 0.03 },
    { type: 'logout', p: 0.02 },
];

const ORDER_STATUS_DIST = [
    { v: 'Delivered', p: 0.60 },
    { v: 'On Board', p: 0.20 },
    { v: 'Pending', p: 0.10 },
    { v: 'Delayed Delivery', p: 0.05 },
    { v: 'Rejected', p: 0.05 },
];

const PAYMENT_STATUS_DIST = [
    { v: 'Paid', p: 0.85 },
    { v: 'Pending', p: 0.10 },
    { v: 'Failed', p: 0.05 },
];

const PAYMENT_METHOD_DIST = [
    { v: 'Card', p: 0.45 },
    { v: 'UPI', p: 0.35 },
    { v: 'COD', p: 0.20 },
];

const ALERT_STATUS_DIST = [
    { v: 'Pending', p: 0.70 },
    { v: 'Reviewed', p: 0.20 },
    { v: 'Blocked', p: 0.10 },
];

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const PRESETS = {
    light: {
        userCount: 100, alertCount: 500, eventCount: 2500, daysBack: 7,
        ringCount: 2, ringSize: [3, 3],
        actionMix: { allow: 0.55, warning: 0.20, requires_otp: 0.15, block: 0.10 }
    },
    medium: {
        userCount: 200, alertCount: 1000, eventCount: 5000, daysBack: 30,
        ringCount: 3, ringSize: [3, 4, 5],
        actionMix: { allow: 0.55, warning: 0.20, requires_otp: 0.15, block: 0.10 }
    },
    heavy: {
        userCount: 400, alertCount: 2000, eventCount: 10000, daysBack: 90,
        ringCount: 5, ringSize: [3, 4, 4, 5, 5],
        actionMix: { allow: 0.55, warning: 0.20, requires_otp: 0.15, block: 0.10 }
    },
};

// ---------------------------------------------------------------------------
// Random utilities
// ---------------------------------------------------------------------------

function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function pickWeighted(dist) {
    const r = Math.random();
    let acc = 0;
    for (const d of dist) {
        acc += d.p;
        if (r <= acc) return d.v || d.type;
    }
    return (dist[dist.length - 1].v || dist[dist.length - 1].type);
}

// Beta-like generator using two uniform samples (Cheng's approximation).
// For low alpha/beta this is biased; cheap & good-enough for synthetic data.
function beta(alpha, betaP) {
    // Marsaglia-style via gamma ratio
    const x = gamma(alpha);
    const y = gamma(betaP);
    return x / (x + y);
}
function gamma(k) {
    // Marsaglia & Tsang for k >= 1, fall back to scaling for k < 1.
    if (k < 1) return gamma(k + 1) * Math.pow(Math.random(), 1 / k);
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
        let x, v;
        do {
            x = gaussian();
            v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = Math.random();
        if (u < 1 - 0.0331 * x * x * x * x) return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
}
function gaussian() {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// ---------------------------------------------------------------------------
// Time distribution
//   - sine-ish daily curve, 9–21h peak
//   - weekends ~70% of weekday volume
//   - one "attack day" 2–3 days ago: 3× alerts / 5× block rate
// ---------------------------------------------------------------------------

function buildTimeProfile(daysBack) {
    const now = Date.now();
    const dayMs = 86400000;
    const attackDayOffset = randInt(2, 3);
    const attackDayStart = new Date(now - attackDayOffset * dayMs);
    attackDayStart.setHours(0, 0, 0, 0);
    return {
        now,
        daysBack,
        attackDayStart: attackDayStart.getTime(),
        attackDayEnd: attackDayStart.getTime() + dayMs,
    };
}

function isAttackTime(profile, ts) {
    return ts >= profile.attackDayStart && ts < profile.attackDayEnd;
}

function sampleTimestamp(profile, { alertWeighted = false } = {}) {
    // Spread uniformly across daysBack, then jitter the time-of-day with a
    // sine-ish weight so 9–21 has ~3× the density of 0–8 / 22–23.
    const dayMs = 86400000;
    const dayOffset = Math.random() * profile.daysBack;

    // Hour weight: cosine bell centred at 15h with min 0.3 at midnight.
    const hourBuckets = [];
    for (let h = 0; h < 24; h++) {
        const w = 0.3 + 0.7 * Math.max(0, Math.cos(((h - 15) / 24) * Math.PI * 2));
        hourBuckets.push(w);
    }
    const sum = hourBuckets.reduce((a, b) => a + b, 0);
    const r = Math.random() * sum;
    let acc = 0, hour = 0;
    for (let h = 0; h < 24; h++) { acc += hourBuckets[h]; if (r <= acc) { hour = h; break; } }
    const minute = Math.floor(Math.random() * 60);
    const second = Math.floor(Math.random() * 60);

    let ts = profile.now - dayOffset * dayMs;
    const d = new Date(ts);
    d.setHours(hour, minute, second, Math.floor(Math.random() * 1000));
    ts = d.getTime();

    // Weekend deflator: ~70% of weekday volume. Re-roll 30% of weekend hits.
    const dow = d.getDay(); // 0 Sun, 6 Sat
    if ((dow === 0 || dow === 6) && Math.random() < 0.30) {
        return sampleTimestamp(profile, { alertWeighted });
    }

    // Attack-day amplifier (only for alerts): re-roll some normal alerts
    // onto the attack day so that day ends up with ~3× normal volume.
    if (alertWeighted && !isAttackTime(profile, ts) && Math.random() < 0.08) {
        const offset = Math.floor(Math.random() * dayMs);
        return profile.attackDayStart + offset;
    }
    return ts;
}

// ---------------------------------------------------------------------------
// User generation
// ---------------------------------------------------------------------------

function classifyUserIndex(i, total, ringUserSet) {
    if (ringUserSet.has(i)) return 'ring';
    const r = i / total;
    if (r < 0.60) return 'normal';
    if (r < 0.85) return 'risky';
    return 'bad';
}

function randomCity() { return pick(CITIES); }

function buildUsers(profile, opts) {
    const { userCount, ringCount, ringSize } = opts;

    // Pre-decide which user indices form rings.
    const ringUsers = [];
    let cursor = 0;
    for (let r = 0; r < ringCount; r++) {
        const size = ringSize[r % ringSize.length];
        const members = [];
        for (let k = 0; k < size; k++) {
            // Place ring members in the last 5% slice (matches "5% in rings").
            const idx = Math.max(0, userCount - 1 - cursor);
            members.push(idx);
            cursor++;
        }
        ringUsers.push({ index: r, members });
    }
    const ringUserSet = new Set(ringUsers.flatMap(r => r.members));

    // bcrypt is slow — hash once and reuse for every synthetic user.
    const sharedHash = bcrypt.hashSync('demo1234', 6);

    const users = [];
    for (let i = 0; i < userCount; i++) {
        const cls = classifyUserIndex(i, userCount, ringUserSet);
        const homeCity = randomCity();
        // 10-digit phone (validation requires exactly 10 digits).
        const phone = String(6000000000 + Math.floor(Math.random() * 3999999999));
        const device = pick(DEVICE_POOL);

        const createdAt = new Date(profile.now - Math.random() * profile.daysBack * 86400000);

        users.push({
            username: `synth_user_${i}`,
            email: `synth_${i}@demo.local`,
            password: sharedHash,
            role: 'customer',
            phoneNumber: phone,
            address: homeCity.city,
            deviceFingerprint: device,
            lastCheckoutDuration: cls === 'bad' ? 5000 : (cls === 'risky' ? 20000 : 60000),
            isBlocked: false,
            failedOTPAttempts: 0,
            failedLoginAttempts: 0,
            synthetic: true,
            createdAt,
            updatedAt: createdAt,
            // Helper fields consumed in-memory only (stripped before insert).
            __class: cls,
            __homeCity: homeCity,
        });
    }

    // Apply ring overwrites — cycle phone / address / device per ring index.
    for (const ring of ringUsers) {
        const mode = ring.index % 3; // 0 phone, 1 address, 2 device
        if (mode === 0) {
            const shared = String(7000000000 + ring.index * 7777777);
            ring.members.forEach(m => { if (users[m]) users[m].phoneNumber = shared; });
        } else if (mode === 1) {
            const sharedCity = pick(CITIES);
            ring.members.forEach(m => {
                if (users[m]) {
                    users[m].address = sharedCity.city;
                    users[m].__homeCity = sharedCity;
                }
            });
        } else {
            const sharedDev = `synth_dev_ring_${ring.index}`;
            ring.members.forEach(m => { if (users[m]) users[m].deviceFingerprint = sharedDev; });
        }
    }

    return { users, ringUsers, ringUserSet };
}

// ---------------------------------------------------------------------------
// Alert generation
// ---------------------------------------------------------------------------

function riskToBaseAction(score) {
    if (score < 2) return 'allow';
    if (score < 4) return 'warning';
    if (score < 7) return 'requires_otp';
    return 'block';
}

function buildOneAlert(profile, userDoc, opts) {
    const ts = sampleTimestamp(profile, { alertWeighted: true });
    const inAttack = isAttackTime(profile, ts);

    // Rule firing
    const rules = [];
    let ruleScore = 0;
    let r5Fired = false;
    let r11Fired = false;
    for (const def of RULE_DEFS) {
        const fired = Math.random() < def.prob;
        const points = fired ? def.points() : 0;
        rules.push({ id: def.id, name: def.name, fired, points });
        if (fired) {
            ruleScore += points;
            if (def.id === 'R5') r5Fired = true;
            if (def.id === 'R11') r11Fired = true;
        }
    }

    // Risk score: 85% low (beta(2,6)*10), 15% high (beta(5,2)*10), capped.
    let riskScore;
    if (Math.random() < 0.85) {
        riskScore = beta(2, 6) * 10;
    } else {
        riskScore = beta(5, 2) * 10;
    }
    if (r11Fired) riskScore = Math.max(riskScore, 9.5);
    riskScore = Math.max(0, Math.min(10, riskScore));

    // Model outputs
    const behaviouralRuleFired = rules.some(r => r.fired && ['R1', 'R3', 'R10'].includes(r.id));
    const lstmProb = Math.min(1, Math.max(0,
        Math.random() * (behaviouralRuleFired ? 1.0 : 0.7) + (behaviouralRuleFired ? 0.2 : 0)));
    const inRing = !!userDoc.__inRing;
    const gnnProb = Math.min(1, Math.max(0,
        Math.random() * (inRing ? 1.0 : 0.6) + (inRing ? 0.3 : 0)));
    const aeMse = Math.min(5, -Math.log(Math.random() || 1e-9) * 2);
    const annProb = sigmoid(0.3 * ruleScore + 0.5 * lstmProb + 0.3 * gnnProb + 0.2 * aeMse * 0.4 - 1.5);

    const models = [
        { id: 'LSTM', name: 'Behavioral LSTM', endpoint: '/predict/behavioral', fired: lstmProb > 0.85, output: { probability: Number(lstmProb.toFixed(4)) } },
        { id: 'GNN', name: 'Graph Neural Network', endpoint: '/predict/graph', fired: gnnProb > 0.85, output: { probability: Number(gnnProb.toFixed(4)) } },
        { id: 'AE', name: 'Autoencoder', endpoint: '/predict/autoencoder', fired: aeMse > 3.5, output: { mse: Number(aeMse.toFixed(4)) } },
        { id: 'ANN', name: 'Master ANN', endpoint: '/predict/master', fired: annProb > 0.85, output: { probability: Number(annProb.toFixed(4)) } },
    ];

    // Action derivation, with 5% random reassignment.
    let action = riskToBaseAction(riskScore);
    if (r11Fired) action = 'block';
    if (Math.random() < 0.05) {
        action = pick(['allow', 'warning', 'requires_otp', 'block']);
    }
    // Attack-day amplifier: 5× block rate (i.e. promote some non-block to block).
    if (inAttack && action !== 'block' && Math.random() < 0.20) {
        action = 'block';
    }

    // Status
    const status = pickWeighted(ALERT_STATUS_DIST);

    // Violation reason: pipe-separated list of fired rule names
    const firedNames = rules.filter(r => r.fired).map(r => r.name);
    const violationReason = firedNames.length ? firedNames.join('|') : 'baseline anomaly';

    // SHAP-ish explanation: 6 keys whose |sum| ≈ riskScore
    const targetSum = riskScore || 0.5;
    const rawComponents = {
        ruleScore: ruleScore,
        lstmProb: lstmProb * 4,
        gnnProb: gnnProb * 3,
        autoMSE: aeMse * 1.5,
        geoSpeed: r5Fired ? rand(2, 5) : rand(-1, 1),
        clusterSize: inRing ? rand(1, 3) : rand(-0.5, 0.5),
    };
    const absSum = Object.values(rawComponents).reduce((a, b) => a + Math.abs(b), 0) || 1;
    const explanation = {};
    for (const [k, v] of Object.entries(rawComponents)) {
        explanation[k] = Number(((v / absSum) * targetSum).toFixed(3));
    }

    // R5 trace numbers (only meaningful when R5 fired, but harmless otherwise)
    const traceR5SpeedKmh = r5Fired ? Math.round(rand(1100, 1800)) : null;
    const traceR5DistanceKm = r5Fired ? Math.round(rand(200, 2000)) : null;

    const decisionTrace = {
        rules,
        models,
        ruleScore: Number(ruleScore.toFixed(2)),
        riskScore: Number(riskScore.toFixed(2)),
        action,
        traceR5SpeedKmh,
        traceR5DistanceKm,
        inAttackDay: inAttack,
    };

    return {
        userId: userDoc._id,
        transactionId: `synth_txn_${Math.random().toString(36).slice(2, 10)}`,
        riskScore: Number(riskScore.toFixed(2)),
        violationReason,
        status,
        explanation,
        decisionTrace,
        action,
        traceR5SpeedKmh,
        traceR5DistanceKm,
        synthetic: true,
        createdAt: new Date(ts),
        updatedAt: new Date(ts),
        __r5Fired: r5Fired,
    };
}

function buildAlerts(profile, users, opts) {
    const { alertCount, actionMix } = opts;

    // Mark ring users so model outputs can lean on it.
    const ringHomeMap = new Map();
    users.forEach(u => { if (u.__class === 'ring') u.__inRing = true; });

    // Bias user selection by class — bad users get ~5× normal weight.
    const weights = users.map(u => {
        if (u.__class === 'bad') return 5;
        if (u.__class === 'risky') return 2.5;
        if (u.__class === 'ring') return 3;
        return 1;
    });
    const wsum = weights.reduce((a, b) => a + b, 0);
    const cumulative = [];
    let c = 0;
    for (const w of weights) { c += w; cumulative.push(c / wsum); }
    function pickUser() {
        const r = Math.random();
        for (let i = 0; i < cumulative.length; i++) if (r <= cumulative[i]) return users[i];
        return users[users.length - 1];
    }

    const alerts = [];
    let attempts = 0;
    const targetActionCounts = {
        allow: Math.round(actionMix.allow * alertCount),
        warning: Math.round(actionMix.warning * alertCount),
        requires_otp: Math.round(actionMix.requires_otp * alertCount),
        block: Math.round(actionMix.block * alertCount),
    };
    const currentActionCounts = { allow: 0, warning: 0, requires_otp: 0, block: 0 };

    while (alerts.length < alertCount && attempts < alertCount * 6) {
        attempts++;
        const u = pickUser();
        const a = buildOneAlert(profile, u, opts);

        // Soft-balance toward target action mix — accept all blocks; if a non-
        // block action category is already 1.4× its quota, force-resample.
        const cap = currentActionCounts[a.action];
        const target = targetActionCounts[a.action] || 1;
        if (a.action !== 'block' && cap > target * 1.4 && Math.random() < 0.7) continue;

        alerts.push(a);
        currentActionCounts[a.action]++;
    }

    // Mark each user with whether they have any R5 fire (drives event placement).
    const r5UserIds = new Set(alerts.filter(a => a.__r5Fired).map(a => String(a.userId)));

    return { alerts, r5UserIds, currentActionCounts };
}

// ---------------------------------------------------------------------------
// Event generation
// ---------------------------------------------------------------------------

function buildOneEvent(profile, userDoc) {
    const ts = sampleTimestamp(profile);
    const useHome = Math.random() < 0.70 && userDoc.__homeCity;
    const loc = useHome ? userDoc.__homeCity : randomCity();
    return {
        userId: userDoc._id,
        eventType: pickWeighted(EVENT_DISTRIBUTION),
        ipAddress: `${randInt(10, 250)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(0, 255)}`,
        location: { lat: loc.lat, lon: loc.lon, city: loc.city, country: loc.country },
        deviceFingerprint: userDoc.deviceFingerprint || pick(DEVICE_POOL),
        timestamp: new Date(ts),
        synthetic: true,
        createdAt: new Date(ts),
        updatedAt: new Date(ts),
    };
}

function buildR5BurstFor(userDoc) {
    // Two events ~5 minutes apart in physically distant cities (Bengaluru → Dubai).
    const bengaluru = CITIES[0];
    const dubai = CITIES[2];
    const t1 = Date.now() - randInt(1, 5) * 86400000 - randInt(0, 60) * 60000;
    const t2 = t1 + 5 * 60000; // 5 min later
    const mk = (loc, ts, type) => ({
        userId: userDoc._id,
        eventType: type,
        ipAddress: `${randInt(10, 250)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(0, 255)}`,
        location: { lat: loc.lat, lon: loc.lon, city: loc.city, country: loc.country },
        deviceFingerprint: userDoc.deviceFingerprint || pick(DEVICE_POOL),
        timestamp: new Date(ts),
        synthetic: true,
        createdAt: new Date(ts),
        updatedAt: new Date(ts),
    });
    return [mk(bengaluru, t1, 'login'), mk(dubai, t2, 'checkout_attempt')];
}

function buildEvents(profile, users, r5UserIds, opts) {
    const events = [];
    const r5Users = users.filter(u => r5UserIds.has(String(u._id)));
    for (const u of r5Users) events.push(...buildR5BurstFor(u));

    const remaining = Math.max(0, opts.eventCount - events.length);
    for (let i = 0; i < remaining; i++) {
        events.push(buildOneEvent(profile, pick(users)));
    }
    return events;
}

// ---------------------------------------------------------------------------
// Order generation
// ---------------------------------------------------------------------------

function logNormalAmount() {
    // Log-normal around ₹2000 with occasional ₹50k+ spikes.
    if (Math.random() < 0.03) return Math.round(rand(50000, 200000));
    const mu = Math.log(2000);
    const sigma = 0.8;
    const v = Math.exp(mu + sigma * gaussian());
    return Math.max(50, Math.round(v));
}

function buildOneOrder(profile, userDoc) {
    const ts = sampleTimestamp(profile);
    const total = logNormalAmount();
    const itemCount = randInt(1, 3);
    const items = [];
    for (let i = 0; i < itemCount; i++) {
        items.push({
            name: `synth-item-${randInt(1, 50)}`,
            price: Math.max(50, Math.round(total / itemCount)),
            quantity: randInt(1, 4),
            image: null,
        });
    }
    return {
        customer: userDoc._id,
        items,
        totalAmount: total,
        status: pickWeighted(ORDER_STATUS_DIST),
        paymentStatus: pickWeighted(PAYMENT_STATUS_DIST),
        paymentMethod: pickWeighted(PAYMENT_METHOD_DIST),
        transactionId: `synth_ord_${Math.random().toString(36).slice(2, 10)}`,
        expectedDeliveryDate: new Date(ts + 86400000 * randInt(1, 7)),
        synthetic: true,
        createdAt: new Date(ts),
    };
}

function buildOrders(profile, users, opts) {
    const count = Math.round(opts.alertCount * 0.3);
    const orders = [];
    for (let i = 0; i < count; i++) orders.push(buildOneOrder(profile, pick(users)));
    return orders;
}

// ---------------------------------------------------------------------------
// Batched insert helper
// ---------------------------------------------------------------------------

async function insertInBatches(Model, docs, batchSize = 500) {
    if (!docs.length) return 0;
    let inserted = 0;
    for (let i = 0; i < docs.length; i += batchSize) {
        const slice = docs.slice(i, i + batchSize);
        try {
            const res = await Model.insertMany(slice, { ordered: false });
            inserted += res.length;
        } catch (err) {
            // ordered:false still throws on partial failure; count successes.
            if (err && err.insertedDocs) inserted += err.insertedDocs.length;
            else if (err && err.result && typeof err.result.insertedCount === 'number') {
                inserted += err.result.insertedCount;
            } else {
                // Best-effort: log and continue.
                // eslint-disable-next-line no-console
                console.warn(`[seedSynthetic] insertMany batch warning on ${Model.modelName}:`, err.message);
            }
        }
    }
    return inserted;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function generate(opts) {
    const required = ['userCount', 'alertCount', 'eventCount', 'daysBack', 'ringCount', 'ringSize', 'actionMix'];
    for (const k of required) {
        if (opts[k] === undefined || opts[k] === null) {
            throw new Error(`seedSynthetic.generate: missing opt "${k}"`);
        }
    }

    const t0 = Date.now();
    const profile = buildTimeProfile(opts.daysBack);

    // 1) Build user docs (in memory).
    const { users: userDocs, ringUsers } = buildUsers(profile, opts);

    // 2) Insert users. We need their assigned _id values for alerts/events/orders.
    //    Strip helper fields before insert and then re-attach _id for downstream use.
    const insertableUsers = userDocs.map(u => {
        const { __class, __homeCity, __inRing, ...rest } = u;
        return rest;
    });
    const usersInserted = await insertInBatches(User, insertableUsers, 500);

    // Re-fetch the synthetic users we just wrote so we have their _id values.
    // Using username pattern is unique enough.
    const writtenUsers = await User.find({ synthetic: true }).select('_id username phoneNumber address deviceFingerprint').lean();
    // Map back helper metadata onto the lean docs (by username index).
    const byUsername = new Map(userDocs.map(u => [u.username, u]));
    const usersForRefs = writtenUsers.map(w => {
        const meta = byUsername.get(w.username) || {};
        return {
            _id: w._id,
            username: w.username,
            phoneNumber: w.phoneNumber,
            address: w.address,
            deviceFingerprint: w.deviceFingerprint,
            __class: meta.__class,
            __homeCity: meta.__homeCity,
            __inRing: meta.__class === 'ring',
        };
    });

    // 3) Build alerts.
    const { alerts, r5UserIds } = buildAlerts(profile, usersForRefs, opts);

    // 4) Side-effects: any alert with action==='block' marks the user blocked.
    //    Aggregate per-user to avoid N writes — we issue a bulkWrite at end.
    const blockOps = new Map();
    for (const a of alerts) {
        if (a.action === 'block') {
            const key = String(a.userId);
            const existing = blockOps.get(key);
            if (!existing || a.createdAt > existing.createdAt) {
                blockOps.set(key, {
                    userId: a.userId,
                    createdAt: a.createdAt,
                    blockedUntil: new Date(a.createdAt.getTime() + 24 * 3600 * 1000),
                    blockReason: a.violationReason,
                });
            }
        }
    }
    if (blockOps.size) {
        const bulk = [];
        for (const op of blockOps.values()) {
            bulk.push({
                updateOne: {
                    filter: { _id: op.userId },
                    update: {
                        $set: {
                            isBlocked: true,
                            blockedAt: op.createdAt,
                            blockedUntil: op.blockedUntil,
                            blockReason: op.blockReason,
                        }
                    }
                }
            });
        }
        try { await User.bulkWrite(bulk, { ordered: false }); }
        catch (e) { console.warn('[seedSynthetic] user block bulkWrite warning:', e.message); }
    }

    // Strip helper fields before insert.
    const insertableAlerts = alerts.map(({ __r5Fired, ...rest }) => rest);

    // 5) Build events (with R5 bursts for users that have any R5 alert).
    const events = buildEvents(profile, usersForRefs, r5UserIds, opts);

    // 6) Build orders.
    const orders = buildOrders(profile, usersForRefs, opts);

    // 7) Insert in parallel (independent collections).
    const [alertsInserted, eventsInserted, ordersInserted] = await Promise.all([
        insertInBatches(FraudAlert, insertableAlerts, 500),
        insertInBatches(EventLog, events, 500),
        insertInBatches(Order, orders, 500),
    ]);

    return {
        created: {
            users: usersInserted,
            alerts: alertsInserted,
            events: eventsInserted,
            orders: ordersInserted,
            rings: ringUsers.length,
        },
        durationMs: Date.now() - t0,
    };
}

module.exports = {
    generate,
    PRESETS,
    CITIES,
    DEVICE_POOL,
};
