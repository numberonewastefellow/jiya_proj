const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const OUTPUT_PATH = path.join(__dirname, '../ml/ann_master_dataset.csv');

async function exportData() {
    try {
        console.log('🚀 Generating master ensemble dataset...');
        const data = [];

        // We will generate 2000 samples for the 'Brain' to learn from
        // Features: [RuleBasedScore, LSTMProb, GNNProb, AutoencoderMSE, UserAgeInDays]
        
        for(let i=0; i<2000; i++) {
            const isFraud = Math.random() > 0.5 ? 1 : 0;
            
            let ruleScore, lstmProb, gnnProb, autoMSE;

            if (isFraud) {
                // Fraudulent patterns tend to have high scores in multiple areas
                ruleScore = 5 + Math.random() * 5;
                lstmProb = 0.6 + Math.random() * 0.4;
                gnnProb = 0.5 + Math.random() * 0.5;
                autoMSE = 2.0 + Math.random() * 5.0;
            } else {
                // Legitimate patterns have low scores
                ruleScore = 0 + Math.random() * 4;
                lstmProb = 0.0 + Math.random() * 0.4;
                gnnProb = 0.0 + Math.random() * 0.3;
                autoMSE = 0.1 + Math.random() * 1.5;
            }

            data.push({
                ruleScore,
                lstmProb,
                gnnProb,
                autoMSE,
                label: isFraud
            });
        }

        const csv = 'ruleScore,lstmProb,gnnProb,autoMSE,label\n' + 
            data.map(d => `${d.ruleScore.toFixed(2)},${d.lstmProb.toFixed(2)},${d.gnnProb.toFixed(2)},${d.autoMSE.toFixed(2)},${d.label}`).join('\n');
        
        fs.writeFileSync(OUTPUT_PATH, csv);

        console.log(`✅ Master dataset created at ${OUTPUT_PATH}`);
    } catch (err) {
        console.error('❌ Export failed:', err);
    }
}

exportData();
