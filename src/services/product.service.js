import { getProductsByBusiness } from '../models/Product.js';
import { openai } from '../config/openai.js';

export function searchProducts(businessId, query) {
  const products = getProductsByBusiness(businessId);
  return products.filter(p => p.name.toLowerCase().includes(query.toLowerCase()));
}

export function getProductByName(businessId, name) {
  const products = getProductsByBusiness(businessId);
  return products.find(p => p.name.toLowerCase() === name.toLowerCase());
}

// Suggest products based on a description using OpenAI
export async function suggestProducts(businessId, userDescription) {
  const products = getProductsByBusiness(businessId);
  const productList = products.map(p => `${p.name}: ${p.description}`).join('\n');

  const prompt = `Based on the user's interest: "${userDescription}", which of the following products would be the best suggestions? Return the product names as a JSON array.
Available products:\n${productList}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });

  const result = JSON.parse(completion.choices[0].message.content);
  const suggestedNames = result.suggestions || [];
  return products.filter(p => suggestedNames.includes(p.name));
}