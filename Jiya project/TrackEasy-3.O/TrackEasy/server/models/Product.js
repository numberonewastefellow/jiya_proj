const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  cost: { type: Number, required: true },
  brand: { type: String, required: true },
  category: { type: String, required: true },
  image: { type: String, required: true },
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

module.exports = mongoose.model('Product', productSchema);
