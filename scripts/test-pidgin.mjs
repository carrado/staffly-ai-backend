import 'dotenv/config';
import * as openaiService from '../src/services/openai.service.js';

const business = { name: 'Acme Stores Limited', aiConfig: { businessTone: 'friendly' } };

// 1. Pidgin message → expect language: "pidgin" and a pidgin response
const pidginOut = openaiService.normalizeAiOutput(
  await openaiService.processMessage('Abeg wetin una get for shoes?', {}, business),
  {},
);
console.log('pidgin in :', JSON.stringify(pidginOut, null, 2));

// 2. English message → expect language: "english"
const englishOut = openaiService.normalizeAiOutput(
  await openaiService.processMessage('Do you have shoes available?', {}, business),
  {},
);
console.log('english in:', JSON.stringify(englishOut, null, 2));

// 3. Ambiguous "ok" with a pidgin session → language should stick to pidgin
const ambiguousOut = openaiService.normalizeAiOutput(
  await openaiService.processMessage(
    'ok',
    {
      language: 'pidgin',
      conversationHistory: [
        { role: 'user', content: 'Abeg wetin una get for shoes?' },
        { role: 'assistant', content: 'We get correct sneakers for you!' },
      ],
    },
    business,
  ),
  { language: 'pidgin' },
);
console.log('ambiguous :', JSON.stringify(ambiguousOut, null, 2));

// 4. normalizeAiOutput unit checks (no API)
const noLang = openaiService.normalizeAiOutput(
  { response: 'hi', action: { type: 'none', data: {} } },
  { language: 'pidgin' },
);
console.log('missing language field, pidgin session →', noLang.language);
const badLang = openaiService.normalizeAiOutput(
  { response: 'hi', language: 'yoruba', action: { type: 'none', data: {} } },
  {},
);
console.log('invalid language field, empty session →', badLang.language);
