const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, '../ml/behavioral_dataset.csv');
const EVENT_TYPES = ['login', 'add_to_cart', 'remove_from_cart', 'checkout_attempt', 'payment_failed', 'payment_success'];
const EVENT_MAP = {
    'login': 1,
    'add_to_cart': 2,
    'remove_from_cart': 3,
    'checkout_attempt': 4,
    'payment_failed': 5,
    'payment_success': 6
};

// Ensure directory exists
const mlDir = path.join(__dirname, '../ml');
if (!fs.existsSync(mlDir)) fs.mkdirSync(mlDir, { recursive: true });

function generateSequence(isBot) {
    const sequence = [];
    const len = 10; // Analysis window
    
    if (isBot) {
        // Bots often spam actions rapidly or repeat failures
        const type = Math.random() > 0.5 ? 'add_to_cart' : 'payment_failed';
        for (let i = 0; i < len; i++) {
            sequence.push(EVENT_MAP[type]);
        }
    } else {
        // Normal users have varied workflows
        sequence.push(EVENT_MAP['login']);
        sequence.push(EVENT_MAP['add_to_cart']);
        sequence.push(EVENT_MAP['add_to_cart']);
        sequence.push(EVENT_MAP['remove_from_cart']);
        sequence.push(EVENT_MAP['add_to_cart']);
        sequence.push(EVENT_MAP['checkout_attempt']);
        sequence.push(EVENT_MAP['payment_success']);
        
        // Fill remaining with random varied actions
        while (sequence.length < len) {
            sequence.push(EVENT_MAP['add_to_cart']);
        }
    }
    return sequence;
}

function startGeneration() {
    console.log('🚀 Generating behavioral dataset...');
    const stream = fs.createWriteStream(OUTPUT_FILE);
    
    // Header: event1, event2, ..., event10, label (1 for fraud, 0 for normal)
    const header = Array.from({length: 10}, (_, i) => `e${i+1}`).join(',') + ',label\n';
    stream.write(header);

    // Generate 1000 normal samples
    for (let i = 0; i < 1000; i++) {
        const seq = generateSequence(false);
        stream.write(seq.join(',') + ',0\n');
    }

    // Generate 1000 bot samples
    for (let i = 0; i < 1000; i++) {
        const seq = generateSequence(true);
        stream.write(seq.join(',') + ',1\n');
    }

    stream.end();
    console.log(`✅ Dataset created at ${OUTPUT_FILE}`);
}

startGeneration();
