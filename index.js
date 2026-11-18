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

// ==========================================
// 1. مساحة بيانات البوت وتعليماته (عدّل هنا براحتك)
// ==========================================
const BOT_INSTRUCTIONS = `
أنت مساعد شخصي ذكي وسريع، ترد على رسائل واتساب بأسلوب ودود ومختصر باللغة العربية (باللهجة المصرية الطبيعية).
- التزم بالمعلومات المذكورة هنا فقط عند السؤال عن تفاصيل العمل أو التواصل، ولا تخترع معلومات غير موجودة.
- أضف بياناتك وتفاصيل شغلك هنا...
`;

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
    const historyCollection = db.collection('chat_history'); // جدول تخزين ذاكرة المحادثات

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
        if (sender.endsWith('@g.us')) return; // تجاهل الجروبات

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        // أمر لمسح ذاكرة المحادثة الحالية
        if (text.trim() === '/مسح') {
            await historyCollection.deleteOne({ _id: sender });
            await sock.sendMessage(sender, { text: 'تم مسح ذاكرة المحادثة بنجاح ✅' }, { quoted: msg });
            return;
        }

        try {
            await sock.sendPresenceUpdate('composing', sender);

            // 2. جلب سجل المحادثة السابق من MongoDB
            const userDoc = await historyCollection.findOne({ _id: sender });
            const pastMessages = userDoc ? userDoc.messages : [];

            const contents = [
                ...pastMessages,
                { role: 'user', parts: [{ text }] }
            ];

            // 3. استدعاء Gemini مع إيقاف التفكير الطويل للرد الفوري
            const response = await ai.models.generateContent({
                model: 'gemini-3.8-flash',
                contents: contents,
                config: {
                    systemInstruction: BOT_INSTRUCTIONS,
                    thinkingConfig: {
                        thinkingBudget: 0
                    }
                }
            });

            const replyText = response.text;

            // 4. حفظ الرسالة الجديدة والرد في MongoDB (الاحتفاظ بآخر 16 رسالة)
            const updatedMessages = [
                ...contents,
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
