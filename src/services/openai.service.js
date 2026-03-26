import { openai } from '../config/openai.js';
import { logger } from '../utils/logger.js';

export async function processMessage(userMessage, session) {
  const { lastProduct, negotiation, conversationHistory = [] } = session;

  // Build context description
  let contextStr = '';
  if (lastProduct) {
    contextStr += `Last product discussed: ${lastProduct.name} (price: ${lastProduct.price}, negotiable: ${lastProduct.allow_negotiation})\n`;
  }
  if (negotiation) {
    contextStr += `Ongoing negotiation for ${negotiation.productName}: original price ${negotiation.originalPrice}, minimum ${negotiation.minPrice}, current offer ${negotiation.currentOffer || 'none'}\n`;
  }

  const systemPrompt = `You are Staffly AI, an intelligent e‑commerce assistant. You have access to the user's conversation context and can perform actions by outputting a JSON object with the following structure:

{
  "response": "Your natural language response to the user.",
  "action": {
    "type": "none | search_products | get_product_details | start_negotiation | make_offer | accept_offer | generate_payment_link",
    "data": { ... }
  }
}

The current context includes:
${contextStr || 'No current context.'}

Rules:
- If the user asks about a product, you may need to search for it. Output an action with type "search_products" and provide a search query in data: { "query": "..." }.
- If the user wants to buy a product, first ensure you know which product. If not, ask. Then use "generate_payment_link" with the product name: { "productName": "..." }.
- For negotiation, use "start_negotiation" to begin with { "productName": "..." }. When the user makes an offer, use "make_offer" with { "offer": number }. When agreement is reached, use "accept_offer" with { "finalPrice": number }.
- Always include a natural language response in the "response" field.
- Use the context to remember what product is being discussed. If the user says "it" or "that", assume they refer to the last product.
- If no action is needed, set action.type to "none".
- Respond only with the JSON object, no other text.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: userMessage }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0].message.content;
    const parsed = JSON.parse(content);
    return parsed;
  } catch (error) {
    logger.error('processMessage failed:', error);
    return {
      response: "I'm sorry, I encountered an error. Please try again.",
      action: { type: 'none' }
    };
  }
}

export async function transcribeAudio(audioBuffer) {
  // In production, send buffer to OpenAI Whisper
  const transcription = await openai.audio.transcriptions.create({
    file: audioBuffer,
    model: 'whisper-1',
  });
  return transcription.text;
}

export async function textToSpeech(text) {
  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'nova',
    input: text,
  });
  return Buffer.from(await mp3.arrayBuffer());
}

/**
 * After an action has been executed, call this to generate the final user‑facing response.
 * @param {string} userMessage - Original user message.
 * @param {object} session - Current session (including lastProduct, negotiation, etc.).
 * @param {object} actionResult - Result data from the executed action.
 * @returns {Promise<object>} - { response: string }
 */
export async function generateResponseWithActionResult(userMessage, session, actionResult) {
  const { lastProduct, negotiation, conversationHistory = [] } = session;

  // Build context description
  let contextStr = '';
  if (lastProduct) {
    contextStr += `Last product discussed: ${lastProduct.name} (price: ${lastProduct.price}, negotiable: ${lastProduct.allow_negotiation}, min_price: ${lastProduct.min_price})\n`;
  }
  if (negotiation) {
    contextStr += `Ongoing negotiation for ${negotiation.productName}: original price ${negotiation.originalPrice}, minimum ${negotiation.minPrice}, current offer ${negotiation.currentOffer || 'none'}\n`;
  }

  const systemPrompt = `You are Staffly AI, an intelligent e‑commerce assistant. 
You have just performed an action requested by the user. The result of that action is provided below.
Now, craft a natural, helpful response to the user that incorporates the action result.

Current context:
${contextStr || 'No current context.'}

Action result:
${JSON.stringify(actionResult, null, 2)}

Respond conversationally, as if you are the assistant. Do not output JSON, only plain text.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory,
    { role: 'user', content: userMessage }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
    });
    return { response: completion.choices[0].message.content };
  } catch (error) {
    logger.error('generateResponseWithActionResult failed:', error);
    return { response: "I'm sorry, I encountered an error while processing your request." };
  }
}