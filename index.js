import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { Boom } from '@hapi/boom';

// ─── Config ────────────────────────────────────────────────────────────────────
const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR  = path.join(__dirname, 'baileys', 'session');
const PORT         = process.env.PORT || 3000;
const PAYMENT_LINK = process.env.PAYMENT_LINK || 'https://your-payment-link.com';

// Ensure session directory exists
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// Silent logger (avoids noisy Baileys debug output in terminal)
const logger = pino({ level: 'silent' });

// ─── Message Builder ───────────────────────────────────────────────────────────
/**
 * @param {'internship' | 'training'} type
 * @param {string} name
 */
function buildMessage(type, name) {
    if (type === 'internship') {
        return (
            `Hello ${name}! 👋\n\n` +
            `Thank you for your interest in the *Swastik Software Solutions* Internship Program! 🎉\n\n` +
            `We've received your application and are excited to have you on board.\n\n` +
            `To confirm your seat and receive your *Offer Letter*, please complete the payment using the link below:\n\n` +
            `💳 *Payment Link:* ${PAYMENT_LINK}\n\n` +
            `Once the payment is done, your Offer Letter will be generated and sent to you.\n\n` +
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

    // ── Request pairing code instead of QR (works on Render logs) ──────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, isNewLogin } = update;

        // Request pairing code when not yet registered
        if (isNewLogin) {
            const phone = process.env.PAIRING_PHONE; // e.g. 919876543210
            if (phone) {
                try {
                    const code = await sock.requestPairingCode(phone);
                    console.log('\n╔══════════════════════════════════════╗');
                    console.log('║  📱 WHATSAPP PAIRING CODE            ║');
                    console.log(`║     👉  ${code}  👈               ║`);
                    console.log('╠══════════════════════════════════════╣');
                    console.log('║  Steps to link:                      ║');
                    console.log('║  1. Open WhatsApp on your phone      ║');
                    console.log('║  2. Settings → Linked Devices        ║');
                    console.log('║  3. Link with Phone Number           ║');
                    console.log('║  4. Enter the code above             ║');
                    console.log('╚══════════════════════════════════════╝\n');
                } catch (err) {
                    console.error('❌ Failed to get pairing code:', err.message);
                }
            } else {
                console.log('⚠️  PAIRING_PHONE env var not set. Add it in Render environment variables.');
                console.log('    Example: PAIRING_PHONE=919876543210  (91 + your 10-digit number)\n');
            }
        }

        if (connection === 'open') {
            isConnected = true;
            console.log('✅ WhatsApp connected successfully!');
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
                console.log('🚫 Logged out. Clear session and restart to re-pair.');
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
// Body: { phone: "9XXXXXXXXX", name: "Applicant", type: "internship" | "training" }
app.post('/send-whatsapp', async (req, res) => {
    const { phone, name, type } = req.body;

    // Validate required fields
    if (!phone || !name) {
        return res.status(400).json({ success: false, error: 'Both "phone" and "name" are required.' });
    }
    if (!type || !['internship', 'training'].includes(type)) {
        return res.status(400).json({ success: false, error: '"type" must be "internship" or "training".' });
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

    const message = buildMessage(type, name);

    try {
        await sock.sendMessage(jid, { text: message });
        console.log(`✉️  [${type.toUpperCase()}] WhatsApp sent → ${jid} (${name})`);
        return res.json({ success: true, message: `WhatsApp sent to ${jid}` });
    } catch (err) {
        console.error('❌ Failed to send WhatsApp:', err);
        return res.status(500).json({ success: false, error: err.message || 'Unknown error' });
    }
});

// ─── Start ───────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 WhatsApp server running on port ${PORT}`);
    console.log(`   POST /send-whatsapp  { phone, name, type: "internship"|"training" }`);
    console.log(`   GET  /ping           Health check (UptimeRobot)\n`);
});

startBaileys();
