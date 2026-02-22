const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const schedule = require('node-schedule');
const axios = require('axios');
const fs = require('fs');
const puppeteer = require('puppeteer');

const BUSINESS = {
    name: "Veachoc",
    ownerName: "Veachoc Team",
    services: "Delivering affordable, plant-based iron through delicious chocolate for daily health, while promoting menstrual health education.",
    pricing: "₹500 to ₹3,500",
    location: "Bangalore",
    workingHours: "9 am to 10 pm",
    bookingLink: "",
    ownerPhone: process.env.OWNER_PHONE || "" // Set via environment variable
};

const OPENROUTER_API = process.env.OPENROUTER_API_KEY;
const MODEL = "mistralai/mixtral-8x7b-instruct";

let client;
let leads = [];
let conversationHistory = {};

const app = express();
app.use(express.json());
app.use(express.static('public'));

function loadData() {
    try {
        if (fs.existsSync('leads.json')) {
            leads = JSON.parse(fs.readFileSync('leads.json'));
        }
        if (fs.existsSync('conversations.json')) {
            conversationHistory = JSON.parse(fs.readFileSync('conversations.json'));
        }
    } catch (e) {
        console.log("Starting fresh");
    }
}

function saveData() {
    fs.writeFileSync('leads.json', JSON.stringify(leads, null, 2));
    fs.writeFileSync('conversations.json', JSON.stringify(conversationHistory, null, 2));
}

async function getAIResponse(userMessage, phoneNumber) {
    const history = conversationHistory[phoneNumber] || [];
    const leadData = leads.find(l => l.phone === phoneNumber) || {};
    
    const systemPrompt = `You are a professional WhatsApp Sales & Support Assistant for ${BUSINESS.name} in ${BUSINESS.location}.

BUSINESS INFORMATION:
- Business: ${BUSINESS.name}
- Services: ${BUSINESS.services}
- Pricing: ${BUSINESS.pricing}
- Location: ${BUSINESS.location}
- Working Hours: ${BUSINESS.workingHours}

PERSONALITY:
- Speak naturally like a real human on WhatsApp
- Short messages, friendly but professional  
- No formal tone, no robotic responses
- Use simple emojis occasionally (🙂 👍 😊)

RULES:
1. Understand the customer's requirement first
2. Provide relevant information about services
3. Qualify the lead: find budget, timeline, requirement
4. Always move toward booking a call or collecting details
5. Never reveal you are AI

CURRENT LEAD INFO: ${JSON.stringify(leadData)}

IMPORTANT: 
- Extract and remember lead info (name, budget, timeline, city, requirement) from conversation
- When customer provides their name, remember it
- When budget is mentioned, note it
- When they want to buy/know more, that's a hot lead
- When you have enough info (name + budget OR name + requirement), suggest booking a call
- End your response with JSON like: {"lead_update": {"name": "John", "budget": "₹500", "timeline": "this week", "city": "Bangalore", "requirement": "iron chocolate"}} - only include fields that were just mentioned/updated

Respond as a human sales executive would. Keep messages short (2-3 lines max).`;

    const messages = [
        { role: "system", content: systemPrompt },
        ...history.slice(-10),
        { role: "user", content: userMessage }
    ];

    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            model: MODEL,
            messages: messages
        }, {
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENROUTER_API}`,
                "HTTP-Referer": "https://whomation.com",
                "X-Title": "Veachoc WhatsApp Assistant"
            }
        });

        const aiResponse = response.data.choices[0].message.content;
        
        // Extract lead update from AI response
        const leadMatch = aiResponse.match(/\{[\s\S]*"lead_update"[\s\S]*\}/);
        if (leadMatch) {
            try {
                const leadUpdate = JSON.parse(leadMatch[0]).lead_update;
                if (leadUpdate) {
                    updateLead(phoneNumber, leadUpdate.name, leadUpdate);
                }
            } catch (e) {}
        }
        
        // Return cleaned response (without the JSON)
        return aiResponse.replace(/\{[\s\S]*"lead_update"[\s\S]*\}/, '').trim();
    } catch (error) {
        console.error("AI Error:", error.message);
        return "Sorry, I'm having trouble connecting. Please try again later.";
    }
}

function updateLead(phone, name, info) {
    const existing = leads.find(l => l.phone === phone);
    if (existing) {
        Object.assign(existing, info);
        if (name && !existing.name) existing.name = name;
    } else {
        leads.push({ phone, name, ...info, createdAt: new Date().toISOString() });
    }
    saveData();
}

async function sendDailySummary() {
    if (!BUSINESS.ownerPhone || !client) return;
    
    const today = new Date().toDateString();
    const newLeads = leads.filter(l => new Date(l.createdAt).toDateString() === today);
    const totalLeads = leads.length;
    
    // Count conversations
    const todayConversations = Object.keys(conversationHistory).filter(phone => {
        const conv = conversationHistory[phone];
        if (!conv || conv.length === 0) return false;
        const lastMsg = conv[conv.length - 1];
        return new Date(lastMsg.timestamp || Date.now()).toDateString() === today;
    }).length;
    
    let summary = `📊 *${BUSINESS.name} Daily Summary*\n`;
    summary += `📅 ${today}\n\n`;
    summary += `💬 Conversations: ${todayConversations}\n`;
    summary += `✨ New Leads: ${newLeads.length}\n`;
    summary += `👥 Total Leads: ${totalLeads}\n`;
    
    if (newLeads.length > 0) {
        summary += `\n🆕 *New Leads Today:*\n`;
        newLeads.forEach((l, i) => {
            summary += `\n${i+1}. ${l.name || 'Unknown'}\n`;
            if (l.phone) summary += `   📱 ${l.phone}\n`;
            if (l.requirement) summary += `   🎯 ${l.requirement}\n`;
            if (l.budget) summary += `   💰 ${l.budget}\n`;
            if (l.timeline) summary += `   ⏰ ${l.timeline}\n`;
            if (l.city) summary += `   📍 ${l.city}\n`;
        });
    }
    
    // Hot leads (have name + budget/requirement)
    const hotLeads = leads.filter(l => l.name && (l.budget || l.requirement));
    if (hotLeads.length > 0) {
        summary += `\n🔥 *Hot Leads (Ready to Convert):*\n`;
        hotLeads.slice(-5).forEach(l => {
            summary += `• ${l.name} - ${l.requirement || l.budget}\n`;
        });
    }
    
    summary += `\n🙌 Have a great day!`;

    try {
        await client.sendMessage(BUSINESS.ownerPhone, summary);
        console.log("Daily summary sent!");
    } catch (e) {
        console.log("Could not send daily summary:", e.message);
    }
}

function startWhatsApp() {
    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: './sessions'
        }),
        puppeteer: {
            headless: true,
            browser: puppeteer,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process'
            ]
        }
    });
    client.on('qr', (qr) => {
        console.log('\n=== SCAN THIS QR WITH WHATSAPP ===\n');
        qrcode.generate(qr, { small: true });
        console.log('\n=====================================\n');
        
        // Also via serve QR web
        qrcode.toDataURL(qr, (err, url) => {
            if (!err) {
                fs.writeFileSync('public/qr.html', getQRPage(url));
            }
        });
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Bot is ready!');
        
        // Schedule daily summary at 8 PM
        schedule.scheduleJob('0 20 * * *', sendDailySummary);
        
        // Send ready message to owner
        if (BUSINESS.ownerPhone) {
            client.sendMessage(BUSINESS.ownerPhone, "✅ Veachoc WhatsApp Bot is now live! 🚀\n\nI'll handle customer queries and send you daily summaries.").catch(() => {});
        }
    });

    client.on('message', async (message) => {
        // Only reply to individual chats, not groups
        if (message.from.includes('@g.us')) return;
        if (message.fromMe) return;
        
        const phone = message.from;
        const userMessage = message.body;
        
        console.log(`📩 ${phone}: ${userMessage}`);
        
        // Save conversation with timestamp
        if (!conversationHistory[phone]) {
            conversationHistory[phone] = [];
        }
        conversationHistory[phone].push({ 
            role: "user", 
            content: userMessage,
            timestamp: new Date().toISOString()
        });
        
        // Get AI response
        const response = await getAIResponse(userMessage, phone);
        
        // Save AI response
        conversationHistory[phone].push({ 
            role: "assistant", 
            content: response,
            timestamp: new Date().toISOString()
        });
        saveData();
        
        // Send reply
        await message.reply(response);
        console.log(`📤 Replied to ${phone}`);
    });

    client.initialize();
}

function getQRPage(qrUrl) {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Veachoc - WhatsApp Login</title>
    <style>
        body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #f0f2f5; margin: 0; }
        .container { text-align: center; padding: 40px; background: white; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
        h1 { color: #075e54; margin-bottom: 10px; }
        p { color: #666; margin-bottom: 30px; }
        img { border-radius: 10px; }
        .status { margin-top: 20px; padding: 10px; border-radius: 5px; background: #e8f5e9; color: #2e7d32; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔗 Connect WhatsApp</h1>
        <p>Scan this QR with your WhatsApp to start</p>
        <img src="${qrUrl}" width="300" />
        <div class="status">⏳ Waiting for scan...</div>
    </div>
    <script>
        setTimeout(() => location.reload(), 30000);
    </script>
</body>
</html>`;
}

// Dashboard
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/leads', (req, res) => {
    res.json(leads);
});

app.get('/qr', (req, res) => {
    res.sendFile(__dirname + '/public/qr.html');
});

loadData();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Dashboard: http://localhost:${PORT}`);
    console.log(`📱 QR Code: http://localhost:${PORT}/qr\n`);
    startWhatsApp();
});
