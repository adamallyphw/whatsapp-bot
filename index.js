const { default: makeWASocket, initAuthCreds, BufferJSON, DisconnectReason } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');

const app = express();
app.get('/', (req, res) => res.send('WhatsApp Bot is Running!'));
app.listen(process.env.PORT || 3000, () => console.log('Web server running'));

const BOT_INSTRUCTIONS = process.env.BOT_INSTRUCTIONS || 'أنت مساعد شخصي ذكي وسريع، ترد على رسائل واتساب بأسلوب ودود ومختصر باللغة العربية. تحدث باللهجة المصرية الطبيعية.';

async function generateWithGroq(pastMessages, newText) {
    const messages = [
        { role: 'system', content: BOT_INSTRUCTIONS }
    ];

    pastMessages.forEach(msg => {
        const role = msg.role === 'model' ? 'assistant' : 'user';
        const content = msg.parts && msg.parts[0] ? msg.parts[0].text : '';
        if (content) messages.push({ role, content });
    });

    messages.push({ role: 'user', content: newText });

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama-3.1-70b-versatile', 
            messages: messages,
            temperature: 0.7
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq API Error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        await collection.replaceOne(
            { _id: id },
            { _id: id, data: JSON.stringify(data, BufferJSON.replacer) },
            { upsert: true }
        );
    };

    const readData = async (id) => {
        const result = await collection.findOne({ _id: id });
        return result ? JSON.parse(result.data, BufferJSON.reviver) : null;
    };

    const removeData = async (id) => {
        await collection.deleteOne({ _id: id });
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function startBot() {
    const mongoClient = new MongoClient(process.env.MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db('whatsapp_bot');
    const authCollection = db.collection('auth_info');
    const historyCollection = db.collection('chat_history');

    const { state, saveCreds } = await useMongoDBAuthState(authCollection);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ البوت شغال ومتصل بالواتساب بنجاح (بسرعة Groq) !');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (sender.endsWith('@g.us')) return; 

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        if (text.trim() === '/مسح') {
            await historyCollection.deleteOne({ _id: sender });
            await sock.sendMessage(sender, { text: 'تم مسح ذاكرة المحادثة بنجاح ✅' }, { quoted: msg });
            return;
        }

        try {
            await sock.sendPresenceUpdate('composing', sender);

            const userDoc = await historyCollection.findOne({ _id: sender });
            const pastMessages = userDoc ? userDoc.messages : [];

            const replyText = await generateWithGroq(pastMessages, text);

            const updatedMessages = [
                ...pastMessages,
                { role: 'user', parts: [{ text }] },
                { role: 'model', parts: [{ text: replyText }] }
            ].slice(-16); 

            await historyCollection.updateOne(
                { _id: sender },
                { $set: { messages: updatedMessages, updatedAt: new Date() } },
                { upsert: true }
            );

            await sock.sendPresenceUpdate('paused', sender);
            await sock.sendMessage(sender, { text: replyText }, { quoted: msg });
        } catch (err) {
            await sock.sendPresenceUpdate('paused', sender);
            console.error('Error:', err);
        }
    });
}

startBot();
