const { default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const MONGO_URI = process.env.MONGO_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MY_NUMBER = process.env.MY_NUMBER; 

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// سيرفر ويب صغير لإبقاء الاستضافة نشطة 24 ساعة
const app = express();
app.get('/', (req, res) => res.send('Bot is Alive and Running!'));
app.listen(process.env.PORT || 8000, () => console.log('Web server running'));

// دالة ربط جلسة الواتساب بقاعدة بيانات MongoDB
async function useMongoAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne(
        { _id: id },
        JSON.parse(JSON.stringify(data, BufferJSON.replacer)),
        { upsert: true }
    );
    const readData = async (id) => {
        const data = await collection.findOne({ _id: id });
        return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
    };
    const removeData = async (id) => await collection.deleteOne({ _id: id });

    const creds = (await readData('creds')) || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
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

// تعليمات شخصية البوت
const SYSTEM_INSTRUCTION = `
أنت مساعد شخصي بترد على الواتساب بالنيابة عني.
- اتكلم باللهجة المصرية بطبيعية وذوق ومن غير تطويل.
- لو الرسالة دردشة عادية أو سلام، رد بلطف.
- لو الرسالة فيها شغل، استفسار عن سعر، مشروع جديد، أو حد عايز يكلمني ضروري:
  1. قوله إنك بلغتني وهرد عليه في أقرب وقت، وخليه يسيب أي تفاصيل إضافية.
  2. حط في آخر ردك الكلمة دي بالظبط: [IMPORTANT]
`;

async function startBot() {
    const mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const collection = mongoClient.db("whatsapp_bot").collection("auth");
    const { state, saveCreds } = await useMongoAuthState(collection);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ البوت شغال ومتصل بالواتساب بنجاح!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (sender.endsWith('@g.us') || sender === 'status@broadcast') return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        const senderName = msg.pushName || sender.split('@')[0];

        try {
            await sock.sendPresenceUpdate('composing', sender);

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `المرسل: ${senderName}\nالرسالة: ${text}`,
                config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.7 }
            });

            let replyText = response.text;

            if (replyText.includes('[IMPORTANT]')) {
                replyText = replyText.replace('[IMPORTANT]', '').trim();
                const alertText = `🚨 *رسالة مهمة على الواتساب*\n\n*من:* ${senderName} (+${sender.split('@')[0]})\n*الرسالة:* ${text}\n\n*رد البوت:* ${replyText}`;
                await sock.sendMessage(MY_NUMBER, { text: alertText });
            }

            setTimeout(async () => {
                await sock.sendMessage(sender, { text: replyText }, { quoted: msg });
            }, 2000);

        } catch (err) {
            console.error('Error:', err);
        }
    });
}

startBot();
