import { openai } from '../config/openai.js';
import { logger } from '../utils/logger.js';

const SYSTEM_PROMPT = `You are Staffly AI, a helpful e‑commerce assistant.
Detect the user's intent and return a JSON object with the following structure:
{
  "type": "greeting | inquiry | order | negotiate | chat | voice",
  "productName": "",          // if applicable
  "query": "",                 // for search
  "offer": 0,                  // for negotiation
  "originalPrice": 0           // for negotiation
}
If the intent is unclear, set type to "chat" and you will respond naturally.`;

export async function detectIntent(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0].message.content;
    return JSON.parse(content);
  } catch (error) {
    logger.error('Intent detection failed:', error);
    return { type: 'chat' }; // fallback
  }
}

export async function generateChatResponse(conversationHistory, userMessage) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a friendly e‑commerce assistant.' },
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ],
  });
  return completion.choices[0].message.content;
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