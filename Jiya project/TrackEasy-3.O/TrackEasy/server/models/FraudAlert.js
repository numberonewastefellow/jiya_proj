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
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('FraudAlert', fraudAlertSchema);
