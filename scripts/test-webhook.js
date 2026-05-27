/**
 * Webhook test script
 *
 * Simulates exactly what velte-backend sends to staffly.
 * Run while staffly dev server is running.
 *
 * Usage:
 *   node scripts/test-webhook.js <event> [customerPhone]
 *
 * Examples:
 *   node scripts/test-webhook.js order.created
 *   node scripts/test-webhook.js order.paid 2348012345678
 *   node scripts/test-webhook.js order.status_changed
 *   node scripts/test-webhook.js product.restocked
 *   node scripts/test-webhook.js invoice.ready
 *   node scripts/test-webhook.js receipt.ready
 *   node scripts/test-webhook.js escalation.requested
 *   node scripts/test-webhook.js bad-signature      ← tests signature rejection
 */

import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ─── Load .env manually (no dotenv dependency needed) ────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../.env');

const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
}

const SECRET        = env.VELTE_WEBHOOK_SECRET;
const PHONE_ID      = env.TEST_PHONE_NUMBER_ID;
const PORT          = env.PORT || 8000;
const WEBHOOK_URL   = `http://localhost:${PORT}/api/velte/webhook`;

if (!SECRET)   { console.error('❌  VELTE_WEBHOOK_SECRET not set in .env'); process.exit(1); }
if (!PHONE_ID) { console.error('❌  TEST_PHONE_NUMBER_ID not set in .env'); process.exit(1); }

// ─── Sample payloads ──────────────────────────────────────────────────────────

const CUSTOMER_PHONE = process.argv[3] || '2348012345678';
const EVENT          = process.argv[2];

const SAMPLE_PAYLOADS = {
  'order.created': {
    event: 'order.created',
    phoneNumberId: PHONE_ID,
    data: {
      orderId: 'ORD-TEST-001',
      customerName: 'Test Customer',
      customerPhone: CUSTOMER_PHONE,
      items: [
        { name: 'Black Sneakers', quantity: 1, lineTotal: 30000 },
        { name: 'White T-Shirt',  quantity: 2, lineTotal: 16000 },
      ],
      amount: 46000,
    },
  },

  'order.paid': {
    event: 'order.paid',
    phoneNumberId: PHONE_ID,
    data: {
      orderId: 'ORD-TEST-001',
      customerName: 'Test Customer',
      customerPhone: CUSTOMER_PHONE,
      amount: 46000,
    },
  },

  'order.status_changed': {
    event: 'order.status_changed',
    phoneNumberId: PHONE_ID,
    data: {
      orderId: 'ORD-TEST-001',
      customerPhone: CUSTOMER_PHONE,
      newStatus: process.env.STATUS || 'Shipped',
      previousStatus: 'Pending',
    },
  },

  'product.restocked': {
    event: 'product.restocked',
    phoneNumberId: PHONE_ID,
    data: {
      productName: 'Black Sneakers',
      newStock: 20,
      customerPhone: CUSTOMER_PHONE,
    },
  },

  'invoice.ready': {
    event: 'invoice.ready',
    phoneNumberId: PHONE_ID,
    data: {
      orderId: 'ORD-TEST-001',
      customerPhone: CUSTOMER_PHONE,
      amount: 46000,
      invoiceUrl: 'https://velte.ng/invoices/ORD-TEST-001',
    },
  },

  'receipt.ready': {
    event: 'receipt.ready',
    phoneNumberId: PHONE_ID,
    data: {
      orderId: 'ORD-TEST-001',
      customerPhone: CUSTOMER_PHONE,
      amount: 46000,
      paidAt: new Date().toISOString(),
      receiptUrl: 'https://velte.ng/receipts/ORD-TEST-001',
    },
  },

  'escalation.requested': {
    event: 'escalation.requested',
    phoneNumberId: PHONE_ID,
    data: {
      customerPhone: CUSTOMER_PHONE,
      merchant: {
        name: 'Demo Store',
        phone: '+2348099887766',
        email: 'owner@demostore.ng',
      },
    },
  },
};

// ─── All status values for order.status_changed ───────────────────────────────

const ALL_STATUSES = ['Preparing', 'Ready', 'Shipped', 'OnTheWay', 'Delivered', 'Cancelled'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sign(bodyString) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(bodyString).digest('hex');
}

async function send(payload, useWrongSignature = false) {
  const body = JSON.stringify(payload);
  const signature = useWrongSignature ? 'sha256=badsignature' : sign(body);

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-velte-signature': signature,
    },
    body,
  });

  return res.status;
}

function printUsage() {
  console.log('\nUsage:  node scripts/test-webhook.js <event> [customerPhone]\n');
  console.log('Events:');
  Object.keys(SAMPLE_PAYLOADS).forEach((e) => console.log(`  ${e}`));
  console.log('  bad-signature      (tests that invalid signatures are rejected)');
  console.log('  all-statuses       (fires order.status_changed for every status)');
  console.log('\nExample:');
  console.log('  node scripts/test-webhook.js order.created 2348012345678\n');
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!EVENT) {
    printUsage();
    process.exit(0);
  }

  console.log(`\n📡  Staffly webhook tester`);
  console.log(`   URL    : ${WEBHOOK_URL}`);
  console.log(`   PhoneID: ${PHONE_ID}`);
  console.log(`   Phone  : ${CUSTOMER_PHONE}\n`);

  // Special: test bad signature rejection
  if (EVENT === 'bad-signature') {
    const status = await send(SAMPLE_PAYLOADS['order.created'], true);
    if (status === 401) {
      console.log('✅  Signature check works — bad signature correctly rejected (401)');
    } else {
      console.log(`❌  Expected 401, got ${status} — signature check may be broken`);
    }
    return;
  }

  // Special: fire all order statuses in sequence
  if (EVENT === 'all-statuses') {
    for (const status of ALL_STATUSES) {
      const payload = {
        ...SAMPLE_PAYLOADS['order.status_changed'],
        data: {
          ...SAMPLE_PAYLOADS['order.status_changed'].data,
          newStatus: status,
          cancellationReason: status === 'Cancelled' ? 'Item out of stock' : undefined,
        },
      };
      const httpStatus = await send(payload);
      const icon = httpStatus === 200 ? '✅' : '❌';
      console.log(`${icon}  order.status_changed [${status}] → HTTP ${httpStatus}`);
      await new Promise((r) => setTimeout(r, 400));
    }
    return;
  }

  const payload = SAMPLE_PAYLOADS[EVENT];
  if (!payload) {
    console.error(`❌  Unknown event: "${EVENT}"`);
    printUsage();
    process.exit(1);
  }

  const status = await send(payload);
  const icon = status === 200 ? '✅' : '❌';
  console.log(`${icon}  ${EVENT} → HTTP ${status}`);

  if (status === 200) {
    console.log(`\n   Check your WhatsApp on ${CUSTOMER_PHONE} for the message.`);
    console.log(`   Also check the staffly server logs for the [Velte] line.\n`);
  }
}

main().catch((err) => {
  console.error('❌ ', err.message);
  process.exit(1);
});
