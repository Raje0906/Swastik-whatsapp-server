import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { Boom } from '@hapi/boom';

// ─── Config ────────────────────────────────────────────────────────────────────
const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, 'baileys', 'session');
const PORT        = process.env.PORT || 3000;

/**
 * Fixed payment links per internship duration.
 * Amounts are PREDEFINED — students cannot change the price.
 *
 * Replace each URL with your actual Razorpay / InstaMojo / UPI payment page
 * that has the amount LOCKED (use "payment page" or "payment button" links
 * where the amount is fixed on your dashboard, not a general QR).
 *
 *  1 month  → ₹199
 *  2 months → ₹299
 *  3 months → ₹399
 *  6 months → ₹499
 */
const PRICING_MAP = {
    1: { amount: 199, link: process.env.PAYMENT_LINK_1M || 'https://rzp.io/l/internship-1month' },
    2: { amount: 299, link: process.env.PAYMENT_LINK_2M || 'https://rzp.io/l/internship-2month' },
    3: { amount: 399, link: process.env.PAYMENT_LINK_3M || 'https://rzp.io/l/internship-3month' },
    6: { amount: 499, link: process.env.PAYMENT_LINK_6M || 'https://rzp.io/l/internship-6month' },
};

// Ensure session directory exists
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// Silent logger (avoids noisy Baileys debug output in terminal)
const logger = pino({ level: 'silent' });

// ─── Message Builder ───────────────────────────────────────────────────────────
/**
 * @param {'internship' | 'training'} type
 * @param {string} name
 * @param {1|2|3|6} [months]  — required for internship type
 */
function buildMessage(type, name, months) {
    if (type === 'internship') {
        const { link: paymentLink, amount } = PRICING_MAP[months];
        return (
            `Hello ${name}! 👋\n\n` +
            `Thank you for your interest in the *Swastik Software Solutions* Internship Program! 🎉\n\n` +
            `We've received your application and are excited to have you on board.\n\n` +
            `📅 *Duration:* ${months} Month${months > 1 ? 's' : ''}\n` +
            `💰 *Amount:* ₹${amount}\n\n` +
            `To confirm your seat and receive your *Offer Letter*, please scan the attached QR code or pay to the UPI ID below:\n\n` +
            `🏦 *UPI ID:* ${process.env.UPI_ID || 'rajeaditya999-2@oksbi'}\n\n` +
            `📸 *Important:* Once the payment is completed, please reply to this message with a screenshot of your successful transaction.\n\n` +
            `Feel free to reach out if you have any questions.\n\n` +
            `Best Regards,\n` +
            `*Swastik Software Solutions Team* 🏢`
        );
    }

    if (type === 'training') {
        return (
            `Hello ${name}! 👋\n\n` +
            `Thank you for your interest in the *Swastik Software Solutions* Advanced Training Program! 🎓\n\n` +
            `We've received your enquiry and our team is glad to connect with you.\n\n` +
            `To help us tailor the best training experience for you, we'd love to know a bit more:\n\n` +
            `🔍 *What exactly are you looking for?*\n` +
            `• A specific technology or skill set?\n` +
            `• Industry certification preparation?\n` +
            `• Corporate / team training?\n` +
            `• Something else entirely?\n\n` +
            `Please reply to this message and let us know — our team will get back to you with a personalised plan!\n\n` +
            `Best Regards,\n` +
            `*Swastik Software Solutions Team* 🏢`
        );
    }

    return null; // unknown type
}

// ─── WhatsApp Socket ────────────────────────────────────────────────────────────
let sock = null;
let isConnected = false;

async function startBaileys() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`\n🔌 Connecting to WhatsApp (Baileys v${version.join('.')})...`);

    sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: ['Swastik Server', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 Scan this QR code with your WhatsApp to link the session:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            isConnected = true;
            console.log('\n✅ WhatsApp connected successfully!');
            console.log('📂 Session saved to whatsapp-server/baileys/session/');
            console.log('You can now press Ctrl+C to stop this local server.');
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect =
                lastDisconnect?.error instanceof Boom &&
                lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;

            console.log(`❌ Connection closed. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startBaileys, 3000);
            } else {
                console.log('🚫 Logged out. Clear session env and restart to re-pair.');
            }
        }
    });
}

// ─── Express App ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── GET /ping — Keep-alive endpoint for UptimeRobot ───────────────────────────
app.get('/ping', (req, res) => {
    res.json({ status: 'alive', connected: isConnected });
});

// ── POST /send-whatsapp ────────────────────────────────────────────────────────
// Body: { phone: "9XXXXXXXXX", name: "Applicant", type: "internship" | "training", months: 1|2|3|6 }
app.post('/send-whatsapp', async (req, res) => {
    const { phone, name, type, months: rawMonths } = req.body;

    // Validate required fields
    if (!phone || !name) {
        return res.status(400).json({ success: false, error: 'Both "phone" and "name" are required.' });
    }
    if (!type || !['internship', 'training'].includes(type)) {
        return res.status(400).json({ success: false, error: '"type" must be "internship" or "training".' });
    }

    // For internship, validate months and look up the server-locked price
    let months = null;
    if (type === 'internship') {
        months = parseInt(rawMonths, 10);
        if (!PRICING_MAP[months]) {
            return res.status(400).json({
                success: false,
                error: `"months" must be one of: ${Object.keys(PRICING_MAP).join(', ')} for internship type.`,
            });
        }
    }
    if (!isConnected || !sock) {
        return res.status(503).json({ success: false, error: 'WhatsApp not connected yet. Please retry in a moment.' });
    }

    // Format number: strip non-digits, take last 10 digits, prepend country code 91
    const cleaned = phone.replace(/\D/g, '').slice(-10);
    if (cleaned.length !== 10) {
        return res.status(400).json({ success: false, error: 'Invalid phone number — must be 10 digits.' });
    }
    const jid = `91${cleaned}@s.whatsapp.net`;

    const message = buildMessage(type, name, months);

    try {
        if (type === 'internship') {
            const qrPath = path.join(__dirname, 'qr_code.jpg');
            // If we find the QR image in the server folder, send as Image + Caption
            if (fs.existsSync(qrPath)) {
                await sock.sendMessage(jid, { image: { url: qrPath }, caption: message });
            } else {
                // Fallback to purely text if the QR image is not found
                await sock.sendMessage(jid, { text: message });
            }
        } else {
            await sock.sendMessage(jid, { text: message });
        }
        const tag = type === 'internship' ? `INTERNSHIP-${months}mo` : 'TRAINING';
        console.log(`✉️  [${tag}] WhatsApp sent → ${jid} (${name}) | ₹${months ? PRICING_MAP[months].amount : 'N/A'}`);
        return res.json({ success: true, message: `WhatsApp sent to ${jid}` });
    } catch (err) {
        console.error('❌ Failed to send WhatsApp:', err);
        return res.status(500).json({ success: false, error: err.message || 'Unknown error' });
    }
});

// ─── Start ───────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 WhatsApp server running on port ${PORT}`);
    console.log(`   POST /send-whatsapp  { phone, name, type: "internship"|"training", months: 1|2|3|6 }`);
    console.log(`   GET  /ping           Health check (UptimeRobot)`);
    console.log(`   💰 Locked prices → 1mo:₹199  2mo:₹299  3mo:₹399  6mo:₹499\n`);
});

startBaileys();
