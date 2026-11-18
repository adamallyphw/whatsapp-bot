const { default: makeWASocket, initAuthCreds, BufferJSON, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const { MongoClient } = require('mongodb');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');

const app = express();
app.get('/', (req, res) => res.send('WhatsApp Bot is Running!'));
app.listen(process.env.PORT || 3000, () => console.log('Web server running'));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// قراءة التعليمات السرية من GitHub Secrets (مع نص افتراضي لو لسه مضفتهاش)
const BOT_INSTRUCTIONS = process.env.BOT_INSTRUCTIONS || 'أنت مساعد شخصي ذكي وسريع، ترد على رسائل واتساب بأسلوب ودود ومختصر باللغة العربية.';

// نظام المحاولة التلقائية والتحويل لموديل Pro عند وجود ضغط
async function generateWithFallback(contents) {
    const modelsToTry = ['gemini-3.8-flash', 'gemini-3.8-pro']; 
    
    for (let i = 0; i < modelsToTry.length; i++) {
        try {
            return await ai.models.generateContent({
                model: modelsToTry[i],
                contents: contents,
                config: {
                    systemInstruction: BOT_INSTRUCTIONS,
                    thinkingConfig: { thinkingBudget: 0 }
                }
            });
        } catch (err) {
            // لو السيرفر مضغوط (503) وفيه موديل احتياطي لسه متجربش
            if (err.status === 503 && i < modelsToTry.length - 1) {
                console.log(`⚠️ ضغط على ${modelsToTry[i]}، جاري التحويل لـ ${modelsToTry[i + 1]}...`);
                continue;
            }
            throw err;
        }
    }
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
            console.log('✅ البوت شغال ومتصل بالواتساب بنجاح !');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (sender.endsWith('@g.us')) return; // تجاهل رسائل الجروبات

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // أمر مسح ذاكرة المحادثة للعميل
        if (text.trim() === '/مسح') {
            await historyCollection.deleteOne({ _id: sender });
            await sock.sendMessage(sender, { text: 'تم مسح ذاكرة المحادثة بنجاح ✅' }, { quoted: msg });
            return;
        }

        try {
            await sock.sendPresenceUpdate('composing', sender);

            const userDoc = await historyCollection.findOne({ _id: sender });
            const pastMessages = userDoc ? userDoc.messages : [];

            const contents = [
                ...pastMessages,
                { role: 'user', parts: [{ text }] }
            ];

            // استدعاء نظام الذكاء الاصطناعي مع التحويل التلقائي
            const response = await generateWithFallback(contents);
            const replyText = response.text;

            const updatedMessages = [
                ...contents,
                { role: 'model', parts: [{ text: replyText }] }
            ].slice(-16); // الاحتفاظ بآخر 16 رسالة فقط

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
