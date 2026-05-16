#!/usr/bin/env node
/**
 * Idempotent demo seeder for TrackEasy.
 *
 * Reads ../seed/*.csv and upserts into MongoDB. Safe to run multiple times.
 *
 * Usage:
 *   docker compose exec trackeasy npm run seed         # idempotent upsert
 *   docker compose exec trackeasy npm run seed:reset   # wipe + reseed
 *
 * Programmatic (server.js auto-boot):
 *   const { seedIfEmpty } = require('./scripts/seed');
 *   await seedIfEmpty();   // no-op if any users already exist
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const FraudAlert = require('../models/FraudAlert');
const EventLog = require('../models/EventLog');

const SEED_DIR = path.join(__dirname, '..', 'seed');

function parseCSV(csvString) {
    const lines = csvString.replace(/\r/g, '').split('\n').filter(l => l.length > 0);
    const parseLine = (line) => {
        const out = [];
        let cur = '';
        let inQ = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') {
                if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
                else inQ = !inQ;
            } else if (c === ',' && !inQ) {
                out.push(cur); cur = '';
            } else {
                cur += c;
            }
        }
        out.push(cur);
        return out;
    };
    const headers = parseLine(lines[0]).map(h => h.trim());
    return lines.slice(1).map(line => {
        const vals = parseLine(line);
        const row = {};
        headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
        return row;
    });
}

async function runSeed({ verbose = true } = {}) {
    const log = verbose ? console.log.bind(console) : () => {};
    const summary = { users: 0, products: 0, orders: 0, alerts: 0, events: 0 };
    const userIdByEmail = {};

    // USERS
    const users = parseCSV(fs.readFileSync(path.join(SEED_DIR, 'users.csv'), 'utf8'));
    for (const u of users) {
        const hash = await bcrypt.hash(u.password, 10);
        const doc = await User.findOneAndUpdate(
            { email: u.email },
            {
                $set: {
                    username: u.username,
                    role: u.role,
                    phoneNumber: u.phoneNumber,
                    address: u.address || '',
                    password: hash
                },
                $setOnInsert: { email: u.email }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        userIdByEmail[u.email] = doc._id;
        summary.users++;
    }
    log(`   ↳ Users upserted: ${summary.users}`);

    // PRODUCTS
    const products = parseCSV(fs.readFileSync(path.join(SEED_DIR, 'products.csv'), 'utf8'));
    for (const p of products) {
        const vendorId = userIdByEmail[p.vendor_email];
        if (!vendorId) throw new Error(`products.csv references unknown vendor: ${p.vendor_email}`);
        await Product.findOneAndUpdate(
            { name: p.name, vendor: vendorId },
            {
                name: p.name,
                cost: Number(p.cost),
                brand: p.brand,
                category: p.category,
                image: p.image,
                vendor: vendorId
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        summary.products++;
    }
    log(`   ↳ Products upserted: ${summary.products}`);

    // ORDERS
    const orders = parseCSV(fs.readFileSync(path.join(SEED_DIR, 'orders.csv'), 'utf8'));
    for (const o of orders) {
        const customerId = userIdByEmail[o.customer_email];
        if (!customerId) throw new Error(`orders.csv references unknown customer: ${o.customer_email}`);
        let items;
        try {
            items = JSON.parse(o.items_json);
        } catch (e) {
            throw new Error(`orders.csv invalid items_json for ${o.orderId}: ${e.message}`);
        }
        const createdAt = new Date(Date.now() - Number(o.days_ago || 0) * 86400000);
        await Order.findOneAndUpdate(
            { orderId: o.orderId },
            {
                orderId: o.orderId,
                customer: customerId,
                items,
                totalAmount: Number(o.totalAmount),
                status: o.status,
                paymentStatus: o.paymentStatus,
                paymentMethod: o.paymentMethod,
                createdAt
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        summary.orders++;
    }
    log(`   ↳ Orders upserted: ${summary.orders}`);

    // FRAUD ALERTS
    const alerts = parseCSV(fs.readFileSync(path.join(SEED_DIR, 'fraud_alerts.csv'), 'utf8'));
    for (const a of alerts) {
        const userId = userIdByEmail[a.user_email];
        if (!userId) throw new Error(`fraud_alerts.csv references unknown user: ${a.user_email}`);
        let explanation = {};
        if (a.explanation_json) {
            try { explanation = JSON.parse(a.explanation_json); }
            catch (e) { throw new Error(`fraud_alerts.csv invalid explanation_json for ${a.transactionId}: ${e.message}`); }
        }
        await FraudAlert.findOneAndUpdate(
            { transactionId: a.transactionId },
            {
                transactionId: a.transactionId,
                userId,
                riskScore: Number(a.riskScore),
                violationReason: a.violationReason,
                status: a.status,
                explanation
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        summary.alerts++;
    }
    log(`   ↳ Fraud alerts upserted: ${summary.alerts}`);

    // EVENT LOG (primes the geo-anomaly demo)
    // Seeded events are tagged ipAddress='seed:loopback' so re-runs can purge prior seeded
    // rows without touching real user-traffic events.
    const eventsPath = path.join(SEED_DIR, 'events.csv');
    if (fs.existsSync(eventsPath)) {
        const events = parseCSV(fs.readFileSync(eventsPath, 'utf8'));
        const seededUids = events.map(e => userIdByEmail[e.user_email]).filter(Boolean);
        await EventLog.deleteMany({ userId: { $in: seededUids }, ipAddress: 'seed:loopback' });
        for (const e of events) {
            const uid = userIdByEmail[e.user_email];
            if (!uid) throw new Error(`events.csv references unknown user: ${e.user_email}`);
            await EventLog.create({
                userId: uid,
                eventType: e.eventType,
                ipAddress: 'seed:loopback',
                location: { lat: Number(e.lat), lon: Number(e.lon), city: e.city, country: e.country },
                timestamp: new Date(Date.now() - Number(e.minutes_ago || 0) * 60000)
            });
            summary.events++;
        }
        log(`   ↳ EventLog rows upserted: ${summary.events}`);
    }

    return { summary, userIdByEmail, users };
}

async function validate({ summary, userIdByEmail, users }) {
    const counts = {
        total_users: await User.countDocuments(),
        admins: await User.countDocuments({ role: 'admin' }),
        managers: await User.countDocuments({ role: 'manager' }),
        vendors: await User.countDocuments({ role: 'vendor' }),
        customers: await User.countDocuments({ role: 'customer' }),
        products: await Product.countDocuments(),
        orders: await Order.countDocuments(),
        alerts: await FraudAlert.countDocuments(),
        events: await EventLog.countDocuments()
    };
    console.log('DB totals:', counts);

    const seedUserIds = Object.values(userIdByEmail);
    const linked = {
        products_linked_to_seed_vendors: await Product.countDocuments({ vendor: { $in: seedUserIds } }),
        orders_linked_to_seed_customers: await Order.countDocuments({ customer: { $in: seedUserIds } }),
        alerts_linked_to_seed_users: await FraudAlert.countDocuments({ userId: { $in: seedUserIds } })
    };
    console.log('Seeded linkage:', linked);

    const errors = [];
    if (linked.products_linked_to_seed_vendors < summary.products)
        errors.push(`Products: expected ≥${summary.products} linked, got ${linked.products_linked_to_seed_vendors}`);
    if (linked.orders_linked_to_seed_customers < summary.orders)
        errors.push(`Orders: expected ≥${summary.orders} linked, got ${linked.orders_linked_to_seed_customers}`);
    if (linked.alerts_linked_to_seed_users < summary.alerts)
        errors.push(`Alerts: expected ≥${summary.alerts} linked, got ${linked.alerts_linked_to_seed_users}`);

    const testEmail = 'customer.alice@trackeasy.com';
    const testUser = await User.findOne({ email: testEmail });
    if (!testUser) {
        errors.push(`Auth check: ${testEmail} not found`);
    } else {
        const ok = await bcrypt.compare('password123', testUser.password);
        if (!ok) errors.push(`Auth check: password mismatch for ${testEmail}`);
    }

    for (const u of users.filter(x => x.role === 'vendor')) {
        const n = await Product.countDocuments({ vendor: userIdByEmail[u.email] });
        if (n < 1) errors.push(`Vendor ${u.email} has no products`);
    }

    return errors;
}

async function seedIfEmpty() {
    const count = await User.countDocuments();
    if (count > 0) return { skipped: true, reason: `users.count=${count}` };
    console.log('🌱 Empty DB detected — running first-time seed…');
    const result = await runSeed({ verbose: true });
    return { skipped: false, ...result };
}

async function seedReset() {
    console.log('🧹 Wiping Users + Products + Orders + FraudAlerts + EventLog…');
    await Promise.all([
        User.deleteMany({}),
        Product.deleteMany({}),
        Order.deleteMany({}),
        FraudAlert.deleteMany({}),
        EventLog.deleteMany({})
    ]);
    console.log('🌱 Re-seeding…');
    return runSeed({ verbose: true });
}

module.exports = { runSeed, seedIfEmpty, seedReset, validate };

// CLI entrypoint — only runs when invoked directly (not when require()'d).
if (require.main === module) {
    require('dotenv').config();
    const mode = process.argv[2] || 'seed';
    const uri = process.env.MONGODB_URI || 'mongodb://mongo:27017/trackeasy';
    (async () => {
        await mongoose.connect(uri);
        console.log(`Connected: ${uri}`);
        try {
            let result;
            if (mode === 'reset') {
                result = await seedReset();
            } else {
                // CLI "seed" runs the idempotent upsert unconditionally (not gated on empty DB).
                // This matches the original scripts/seed.js behaviour.
                result = await runSeed({ verbose: true });
            }
            console.log('\n--- VALIDATION ---');
            const errors = await validate(result);
            if (errors.length) {
                console.error('\nVALIDATION FAILED:\n' + errors.map(e => '  - ' + e).join('\n'));
                process.exit(2);
            }
            console.log('\nAll validations passed.');
            process.exit(0);
        } catch (e) {
            console.error('Seed failed:', e);
            process.exit(1);
        }
    })();
}
