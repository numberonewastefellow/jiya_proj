const mongoose = require('mongoose');

const eventLogSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    sessionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'UserSession'
    },
    eventType: {
        type: String,
        required: true,
        enum: ['login', 'add_to_cart', 'remove_from_cart', 'checkout_attempt', 'payment_attempt', 'payment_success', 'payment_failed', 'logout']
    },
    ipAddress: {
        type: String
    },
    location: {
        lat: Number,
        lon: Number,
        city: String,
        country: String
    },
    deviceFingerprint: {
        type: String,
        trim: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    },
    synthetic: {
        type: Boolean,
        default: false,
        index: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('EventLog', eventLogSchema);
