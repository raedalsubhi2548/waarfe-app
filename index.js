// ===== سيرفر شات وارف - Waarfe Chat Server =====
// ملف: index.js
// 
// المتغيرات المطلوبة في .env:
//   ANTHROPIC_API_KEY=sk-ant-...
//   SALLA_CLIENT_ID=...
//   SALLA_CLIENT_SECRET=...
//   SALLA_STORE_DOMAIN=waarfe.com   (اختياري - للعرض فقط)
//   PORT=3000                        (اختياري)

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// ===== CORS - يسمح للودجت بالتواصل من أي دومين =====
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ===== الثوابت =====
const SALLA_API_BASE = 'https://api.salla.dev/admin/v2';
const SALLA_CLIENT_ID = process.env.SALLA_CLIENT_ID;
const SALLA_CLIENT_SECRET = process.env.SALLA_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let sallaAccessToken = null;
let tokenExpiry = 0;

// ===== Salla Token =====
async function getSallaAccessToken() {
    // لو التوكن لسا صالح
    if (sallaAccessToken && Date.now() < tokenExpiry) return sallaAccessToken;
    try {
        const response = await axios.post('https://accounts.salla.dev/oauth2/token', {
            client_id: SALLA_CLIENT_ID,
            client_secret: SALLA_CLIENT_SECRET,
            grant_type: 'client_credentials'
        }, {
            headers: { 'Content-Type': 'application/json' }
        });
        sallaAccessToken = response.data.access_token;
        // نجدد قبل انتهاء الصلاحية بـ 5 دقائق
        tokenExpiry = Date.now() + ((response.data.expires_in || 3600) - 300) * 1000;
        console.log('✅ تم الحصول على توكن سلة');
        return sallaAccessToken;
    } catch (error) {
        console.error('❌ فشل في الحصول على توكن سلة:', error.message);
        return null;
    }
}

// ===== جلب حالة الطلب من سلة =====
async function getOrderByNumber(orderNumber) {
    await getSallaAccessToken();
    if (!sallaAccessToken) return null;
    try {
        const response = await axios.get(`${SALLA_API_BASE}/orders`, {
            headers: { 'Authorization': `Bearer ${sallaAccessToken}` },
            params: { search: orderNumber }
        });
        const orders = response.data.data || [];
        return orders.length > 0 ? orders[0] : null;
    } catch (error) {
        console.error('❌ خطأ في استرجاع الطلب:', error.message);
        return null;
    }
}

// ===== استخراج رقم الطلب (ذكي - يمنع التقاط أرقام عشوائية) =====
function extractOrderNumber(text) {
    if (!text) return null;

    // أنماط واضحة: "رقم طلبي 12345" أو "طلب رقم 12345" أو "#12345" أو "order 12345"
    const patterns = [
        /(?:رقم\s*طلب(?:ي)?|طلب\s*(?:رقم|#)?|رقم\s*(?:ال)?طلب|order\s*#?\s*|#)\s*(\d{4,})/i,
        /(?:طلبي|طلب)\s+(\d{4,})/i,
        /(?:متابعة|تتبع|حالة)\s+(?:طلب\s*)?#?\s*(\d{4,})/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
    }

    // لو النص كله رقم (5 خانات أو أكثر) والسياق فيه كلمة "طلب"
    const hasOrderContext = /طلب|order|متابعة|تتبع|حالة/i.test(text);
    if (hasOrderContext) {
        const numMatch = text.match(/\b(\d{5,})\b/);
        if (numMatch) return numMatch[1];
    }

    return null;
}

// ===== تحديد الاختصارات حسب نوع السؤال =====
function getQuickReplies(message, hasOrder) {
    if (hasOrder) {
        return ['متابعة الطلب', 'التواصل مع الدعم', 'سياسة الاسترجاع'];
    }
    const msgLower = message.toLowerCase();
    if (/خدم|سعر|تكلف|كم|باقة|عرض/i.test(msgLower)) {
        return ['وش المتطلبات؟', 'مدة التنفيذ', 'طريقة التسليم'];
    }
    if (/طلب|متابع|تتبع/i.test(msgLower)) {
        return ['متابعة الطلب', 'التواصل مع الدعم'];
    }
    // افتراضي
    return null; // الودجت يعرض الاختصارات الافتراضية
}

// ===== System Prompt صارم لـ Claude =====
function buildSystemPrompt(pageUrl, pageTitle, pageExcerpt) {
    return `أنت "مساعد وارف" — مساعد خدمة عملاء لمتجر وارف للخدمات الرقمية.

## قواعد صارمة:
1. المصدر الوحيد لمعلومات الخدمة هو "سياق الصفحة" المرفق أدناه. لا تخترع أي سعر أو مدة أو تفاصيل غير مذكورة فيه.
2. إذا لم تجد المعلومة في سياق الصفحة، اسأل سؤال واحد فقط للتوضيح بدل التخمين. مثال: "ممكن توضح لي أكثر وش تحتاج بالضبط؟ 😊"
3. ممنوع الفلسفة أو الردود الطويلة. الرد يكون 3–6 أسطر كحد أقصى.
4. استخدم نقاط (•) عند سرد أكثر من عنصر.
5. اللهجة: سعودية ودّية محترمة. استخدم إيموجي خفيف فقط عند اللزوم (1-2 إيموجي بالكثير).
6. لا ترحب بالعميل في كل رد — ادخل في الموضوع مباشرة.
7. لو العميل سأل عن شيء خارج نطاق المتجر، وجّهه بلطف إن التواصل مع الدعم أفضل.

## سياق الصفحة:
- الرابط: ${pageUrl || 'غير محدد'}
- عنوان الصفحة: ${pageTitle || 'غير محدد'}
- محتوى الصفحة:
${pageExcerpt || 'لا يوجد محتوى متاح'}
`;
}

// ===== إرسال لـ Claude =====
async function askClaude(userMessage, systemPrompt) {
    try {
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-haiku-20240307',
            max_tokens: 400,
            temperature: 0.3,
            system: systemPrompt,
            messages: [
                { role: 'user', content: userMessage }
            ]
        }, {
            headers: {
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            }
        });
        return response.data.content[0].text;
    } catch (error) {
        console.error('❌ خطأ Claude:', error.response?.data || error.message);
        return 'عذراً، صار خطأ تقني. حاول مرة ثانية أو تواصل مع الدعم 🙏';
    }
}

// ===== تنسيق رد الطلب =====
function formatOrderReply(order) {
    const status = order.status?.name || order.status || 'غير محدد';
    const total = order.total ? `${order.total} ريال` : 'غير محدد';
    const date = order.date?.date || order.created_at || '';

    let reply = `📦 طلبك رقم #${order.id}:\n`;
    reply += `• الحالة: ${status}\n`;
    reply += `• المبلغ: ${total}`;
    if (date) reply += `\n• التاريخ: ${date}`;
    reply += `\n\nإذا تحتاج أي شيء ثاني، أنا هنا 😊`;
    return reply;
}

// ===== API Endpoint =====
app.post('/api/chat', async (req, res) => {
    const { message, page_url, page_title, page_excerpt } = req.body;

    console.log(`📩 سؤال: ${message}`);

    if (!message || !message.trim()) {
        return res.json({ reply: 'مرحباً! كيف أقدر أساعدك؟ 😊' });
    }

    const userMessage = message.trim();

    // 1) محاولة استخراج رقم طلب
    const orderNumber = extractOrderNumber(userMessage);

    if (orderNumber) {
        console.log(`🔍 بحث عن طلب: ${orderNumber}`);
        const order = await getOrderByNumber(orderNumber);
        if (order) {
            return res.json({
                reply: formatOrderReply(order),
                quick_replies: getQuickReplies(userMessage, true)
            });
        } else {
            return res.json({
                reply: `ما لقيت طلب بالرقم ${orderNumber} 🤔\nتأكد من الرقم وحاول مرة ثانية، أو تواصل مع الدعم.`,
                quick_replies: ['التواصل مع الدعم', 'متابعة الطلب']
            });
        }
    }

    // 2) ما فيه رقم طلب → نرسل لـ Claude
    const systemPrompt = buildSystemPrompt(page_url, page_title, page_excerpt);
    const aiReply = await askClaude(userMessage, systemPrompt);

    return res.json({
        reply: aiReply,
        quick_replies: getQuickReplies(userMessage, false)
    });
});

// ===== الصفحة الرئيسية =====
app.get('/', (req, res) => {
    res.send(`
        <html dir="rtl" lang="ar">
        <head><meta charset="UTF-8"><title>سيرفر وارف</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:50px;">
            <h1>🤖 سيرفر شات وارف يعمل!</h1>
            <p>أرسل POST إلى <code>/api/chat</code></p>
        </body></html>
    `);
});

// ===== تشغيل السيرفر =====
app.listen(port, async () => {
    console.log(`🚀 سيرفر وارف يعمل على المنفذ: ${port}`);
    await getSallaAccessToken();
});
