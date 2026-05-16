const mongoose = require('mongoose');

const fraudAlertSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    transactionId: {
        type: String
    },
    riskScore: {
        type: Number,
        required: true
    },
    violationReason: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['Pending', 'Reviewed', 'Blocked', 'Resolved'],
        default: 'Pending'
    },
    explanation: {
        type: mongoose.Schema.Types.Mixed // Stores SHAP-like feature contributions
    },
    decisionTrace: {
        type: mongoose.Schema.Types.Mixed // Full per-rule + per-model breakdown captured at evaluation time (drives Blocked Users details panel)
    },
    action: {
        type: String // 'allow' | 'warning' | 'requires_otp' | 'block'
    },
    traceR5SpeedKmh: {
        type: Number
    },
    traceR5DistanceKm: {
        type: Number
    },
    synthetic: {
        type: Boolean,
        default: false,
        index: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('FraudAlert', fraudAlertSchema);
