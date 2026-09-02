const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

// Initialize WhatsApp Client with Local Auth (persists session after first scan)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// OLLAMA API Configuration
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL_NAME = 'kamila3';

// Display QR Code for WhatsApp Login
client.on('qr', (qr) => {
    console.log('=== SCAN THIS QR CODE WITH YOUR WHATSAPP ===');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Kamila WhatsApp Bot is active and connected!');
});

// Process Incoming Messages
client.on('message', async (msg) => {
    // Ignore status broadcasts and empty messages
    if (msg.from === 'status@broadcast' || !msg.body || msg.body.trim() === '') return;

    const chat = await msg.getChat();

    // Send typing indicator
    await chat.sendStateTyping();

    try {
        // Send prompt to local Ollama instance
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_NAME,
            messages: [
                { role: 'user', content: msg.body }
            ],
            stream: false
        });

        const kamilaReply = response.data.message.content;

        // Reply to the user
        await msg.reply(kamilaReply);
    } catch (error) {
        console.error('Error communicating with Ollama:', error.message);
        await msg.reply('⚠️ *Kamila Error*: I had trouble reaching my local AI server. Please make sure Ollama is running on your PC.');
    }
});

client.initialize();
