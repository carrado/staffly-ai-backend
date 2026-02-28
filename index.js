import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();
const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


// ==========================================
// MOCK DATABASE (Replace with real DB)
// ==========================================

const businesses = [
  {
    id: "biz_001",
    phone_number_id: process.env.TEST_PHONE_NUMBER_ID,
    access_token: process.env.META_ACCESS_TOKEN,
  },
];

const products = [
  {
    business_id: "biz_001",
    name: "Black Sneakers",
    size: "42",
    price: 30000,
    stock: 5,
  },
];


// ==========================================
// TOOL FUNCTIONS
// ==========================================

async function searchProduct(businessId, query) {
  return products.filter(
    (p) =>
      p.business_id === businessId &&
      p.name.toLowerCase().includes(query.toLowerCase())
  );
}

async function generateInvoice(businessId, productName) {
  const product = products.find(
    (p) => p.business_id === businessId && p.name === productName
  );

  if (!product) return null;

  const paymentLink = `https://paystack.com/pay/demo-${Date.now()}`;

  return {
    product: product.name,
    amount: product.price,
    paymentLink,
  };
}

async function negotiatePrice(originalPrice, offeredPrice) {
  const minAcceptable = originalPrice * 0.85;

  if (offeredPrice >= minAcceptable) {
    return {
      accepted: true,
      finalPrice: offeredPrice,
    };
  } else {
    return {
      accepted: false,
      counterPrice: Math.floor(originalPrice * 0.9),
    };
  }
}


// ==========================================
// WEBHOOK VERIFICATION
// ==========================================

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});


// ==========================================
// MAIN WEBHOOK MESSAGE HANDLER
// ==========================================

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages) return res.sendStatus(200);

    const message = value.messages[0];
    const customerNumber = message.from;
    const messageText = message.text?.body;
    const phoneNumberId = value.metadata.phone_number_id;

    const business = businesses.find(
      (b) => b.phone_number_id === phoneNumberId
    );

    if (!business) return res.sendStatus(200);

    const aiResponse = await processWithAI(
      business.id,
      messageText
    );

    await sendWhatsAppMessage(
      phoneNumberId,
      business.access_token,
      customerNumber,
      aiResponse
    );

    res.sendStatus(200);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.sendStatus(500);
  }
});


// ==========================================
// AI ENGINE WITH TOOL CALLING
// ==========================================

async function processWithAI(businessId, userMessage) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
        You are Staffly AI.
        Detect user intent:
        - greeting
        - product_search
        - negotiation
        - purchase
        - other

        Return JSON only.
        `,
      },
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  const intent = JSON.parse(completion.choices[0].message.content);

  // -------------------------
  // Handle intents
  // -------------------------

  if (intent.type === "greeting") {
    return "Hello 👋 Welcome! How can I help you today?";
  }

  if (intent.type === "product_search") {
    const results = await searchProduct(businessId, intent.query);

    if (!results.length) {
      return "Sorry, we don't have that product available.";
    }

    const product = results[0];

    return `Yes ✅ We have ${product.name} (Size ${product.size}) for ₦${product.price}. Would you like to buy?`;
  }

  if (intent.type === "negotiation") {
    const negotiation = await negotiatePrice(
      intent.originalPrice,
      intent.offer
    );

    if (negotiation.accepted) {
      return `Deal accepted 🎉 Final price: ₦${negotiation.finalPrice}`;
    } else {
      return `We can offer it for ₦${negotiation.counterPrice}. Is that okay?`;
    }
  }

  if (intent.type === "purchase") {
    const invoice = await generateInvoice(
      businessId,
      intent.productName
    );

    if (!invoice) return "Product not found.";

    return `Here is your payment link:
${invoice.paymentLink}

Amount: ₦${invoice.amount}`;
  }

  return "I'm here to help 😊 Could you clarify what you need?";
}


// ==========================================
// SEND WHATSAPP MESSAGE
// ==========================================

async function sendWhatsAppMessage(
  phoneNumberId,
  accessToken,
  to,
  message
) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: to,
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );
}


// ==========================================
// OAUTH CALLBACK (Embedded Signup)
// ==========================================

app.get("/meta/callback", async (req, res) => {
  const code = req.query.code;

  const tokenResponse = await axios.get(
    `https://graph.facebook.com/v22.0/oauth/access_token`,
    {
      params: {
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: process.env.META_REDIRECT_URI,
        code: code,
      },
    }
  );

  const accessToken = tokenResponse.data.access_token;

  // Store in DB properly
  console.log("New Business Connected:", accessToken);

  res.send("WhatsApp Connected Successfully");
});


app.listen(3000, () => {
  console.log("🚀 Staffly AI backend running on port 3000");
});