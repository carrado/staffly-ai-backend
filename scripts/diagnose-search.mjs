import 'dotenv/config';
import mongoose from 'mongoose';
import { addBusiness } from '../src/models/Business.js';
import { searchProducts, getProductById } from '../src/services/product.service.js';
import { searchProductsFromList } from '../src/models/Products.js';
import { Product } from '../src/models/mongoose/Product.js';

const QUERY = process.argv[2] || 'shoes';
const SETUP_ID = '6a136fa1f17da368fbf694d8';

await mongoose.connect(process.env.MONGODB_URI);

const setup = await mongoose.connection.db
  .collection('aisetups')
  .findOne({ _id: new mongoose.Types.ObjectId(SETUP_ID) });
const vendorId = setup.userId.toString();

const docs = await Product.find({ vendorId }).lean();
console.log(`--- Raw products for vendor ${vendorId} (${docs.length}) ---`);
for (const d of docs) {
  console.log({
    name: d.name,
    categoryId: d.categoryId,
    tags: d.tags,
    stockQuantity: d.stockQuantity,
    orderedQuantity: d.orderedQuantity,
    expirationDate: d.expirationDate,
    businessType: d.businessType,
    isCurrentlyAvailable: d.isCurrentlyAvailable,
    isNegotiable: d.isNegotiable,
  });
}

// Map every product through the real conversion, availability filter OFF
const mapped = (await Promise.all(docs.map((d) => getProductById(d._id.toString())))).filter(Boolean);
console.log(`\n--- Mapped (${mapped.length}) ---`);
for (const p of mapped) {
  console.log(`${p.name}: stock=${p.stock}, is_available=${p.is_available}, category="${p.category}", tags=[${p.tags}]`);
}

const scoredIgnoringAvailability = searchProductsFromList(mapped, QUERY, 50);
console.log(`\n--- searchProductsFromList("${QUERY}") ignoring availability: ${scoredIgnoringAvailability.length} ---`);
scoredIgnoringAvailability.forEach((p) => console.log(`  ${p.name}`));

addBusiness({ id: 'diag', phone_number_id: 'x', access_token: 'x', velteUserId: vendorId });
const real = await searchProducts('diag', QUERY, 50);
console.log(`\n--- Real searchProducts("${QUERY}") with availability filter: ${real.length} ---`);
real.forEach((p) => console.log(`  ${p.name}`));

await mongoose.disconnect();
