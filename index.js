// ===== سيرفر شات وارف v2 =====
// .env المطلوب:
//   ANTHROPIC_API_KEY=sk-ant-...
//   SALLA_CLIENT_ID=...
//   SALLA_CLIENT_SECRET=...
//   PORT=3000 (اختياري)

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ===== Salla =====
const SALLA_API_BASE = 'https://api.salla.dev/admin/v2';
const SALLA_CLIENT_ID = process.env.SALLA_CLIENT_ID;
const SALLA_CLIENT_SECRET = process.env.SALLA_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let sallaAccessToken = null;
let tokenExpiry = 0;

async function getSallaToken() {
    if (sallaAccessToken && Date.now() < tokenExpiry) return sallaAccessToken;
    try {
        const r = await axios.post('https://accounts.salla.dev/oauth2/token', {
            client_id: SALLA_CLIENT_ID,
            client_secret: SALLA_CLIENT_SECRET,
            grant_type: 'client_credentials'
        }, { headers: { 'Content-Type': 'application/json' } });
        sallaAccessToken = r.data.access_token;
        tokenExpiry = Date.now() + ((r.data.expires_in || 3600) - 300) * 1000;
        console.log('✅ توكن سلة تم');
        return sallaAccessToken;
    } catch (e) {
        console.error('❌ توكن سلة فشل:', e.message);
        return null;
    }
}

async function getOrder(orderNumber) {
    await getSallaToken();
    if (!sallaAccessToken) return null;
    try {
        const r = await axios.get(`${SALLA_API_BASE}/orders`, {
            headers: { 'Authorization': `Bearer ${sallaAccessToken}` },
            params: { search: orderNumber }
        });
        const orders = r.data.data || [];
        return orders.length > 0 ? orders[0] : null;
    } catch (e) {
        console.error('❌ خطأ جلب الطلب:', e.message);
        return null;
    }
}

// ===== استخراج رقم الطلب (ذكي) =====
function extractOrderNumber(text) {
    if (!text) return null;
    const patterns = [
        /(?:رقم\s*طلب(?:ي)?|طلب\s*(?:رقم|#)?|رقم\s*(?:ال)?طلب|order\s*#?\s*|#)\s*(\d{4,})/i,
        /(?:طلبي|طلب)\s+(\d{4,})/i,
        /(?:متابعة|تتبع|حالة)\s+(?:طلب\s*)?#?\s*(\d{4,})/i,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[1];
    }
    if (/طلب|order|متابعة|تتبع|حالة/i.test(text)) {
        const m = text.match(/\b(\d{5,})\b/);
        if (m) return m[1];
    }
    return null;
}

// ===== اختصارات ذكية =====
function getQuickReplies(msg, hasOrder) {
    if (hasOrder) return ['متابعة الطلب', 'التواصل مع الدعم', 'سياسة الاسترجاع'];
    if (/خدم|سعر|تكلف|كم|باقة|عرض|اسعار/i.test(msg)) return ['وش المتطلبات؟', 'مدة التنفيذ', 'طريقة التسليم'];
    if (/طلب|متابع|تتبع/i.test(msg)) return ['متابعة الطلب', 'التواصل مع الدعم'];
    return null;
}

// ===== System Prompt - عفوي وصارم =====
function buildSystemPrompt(pageUrl, pageTitle, pageExcerpt) {
    return `أنت مساعد وارف — صاحب العميل اللي يساعده بكل بساطة.

## شخصيتك:
- تكلم العميل كأنك صاحبه، بلهجة سعودية خفيفة وودّية
- ردودك مختصرة ومباشرة (سطرين إلى 4 أسطر بالكثير)
- لا تسوي مقدمات أو ترحيب زايد — ادخل بالموضوع
- استخدم إيموجي واحد أو اثنين بالكثير، وبس لو يناسب
- لو تحتاج معلومة من العميل، اسأله سؤال واحد واضح ومحدد بدل ما تكتب كلام كثير

## قواعد صارمة:
1. معلوماتك عن الخدمات والأسعار والتفاصيل مصدرها الوحيد هو "محتوى الصفحة" تحت. لا تخترع أي سعر أو مدة أو تفصيلة مو موجودة فيه.
2. لو المعلومة مو موجودة، لا تقول "ما عندي معلومة" أو "بناء على الصفحة". بدالها اسأل العميل سؤال يساعدك تفيده، أو وجّهه للتواصل المباشر.
3. ممنوع تقول أبداً "بناء على محتوى الصفحة" أو "حسب المعلومات المتوفرة" أو أي عبارة تكشف إنك تقرأ من مصدر. تكلم بشكل طبيعي.
4. لو العميل سأل عن شي ما تعرفه: "والله ما عندي التفصيلة ذي، بس تقدر تتواصل مع الفريق وبيفيدونك 😊"
5. استخدم نقاط (•) بس لو تسرد 3 أشياء أو أكثر.

## محتوى الصفحة:
عنوان: ${pageTitle || ''}
${pageExcerpt || 'لا يوجد محتوى'}
`;
}

// ===== Claude API =====
async function askClaude(userMessage, systemPrompt) {
    try {
        const r = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-haiku-20240307',
            max_tokens: 350,
            temperature: 0.3,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }]
        }, {
            headers: {
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            }
        });
        return r.data.content[0].text;
    } catch (e) {
        console.error('❌ Claude خطأ:', e.response?.data || e.message);
        return 'عذراً صار خطأ تقني، حاول مرة ثانية أو كلم الدعم 🙏';
    }
}

// ===== رد الطلب =====
function formatOrderReply(order) {
    const status = order.status?.name || order.status || 'غير محدد';
    const total = order.total ? `${order.total} ريال` : '';
    let r = `طلبك #${order.id} حالته: ${status}`;
    if (total) r += ` 💰 المبلغ: ${total}`;
    r += `\n\nتحتاج شي ثاني؟ 😊`;
    return r;
}

// ===== API =====
app.post('/api/chat', async (req, res) => {
    const { message, page_url, page_title, page_excerpt } = req.body;

    if (!message?.trim()) {
        return res.json({ reply: 'هلا! وش تبي تعرف؟ 😊' });
    }

    const msg = message.trim();
    console.log(`📩 ${msg}`);

    // 1) طلب؟
    const orderNum = extractOrderNumber(msg);
    if (orderNum) {
        console.log(`🔍 طلب: ${orderNum}`);
        const order = await getOrder(orderNum);
        if (order) {
            return res.json({ reply: formatOrderReply(order), quick_replies: getQuickReplies(msg, true) });
        }
        return res.json({
            reply: `ما لقيت طلب بالرقم ${orderNum} 🤔 تأكد من الرقم وجرب مرة ثانية`,
            quick_replies: ['التواصل مع الدعم', 'متابعة الطلب']
        });
    }

    // 2) Claude
    const sp = buildSystemPrompt(page_url, page_title, page_excerpt);
    const reply = await askClaude(msg, sp);

    return res.json({ reply, quick_replies: getQuickReplies(msg, false) });
});

app.get('/', (req, res) => {
    res.send('<html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>🤖 سيرفر وارف شغال!</h1><p>POST → /api/chat</p></body></html>');
});

app.listen(port, async () => {
    console.log(`🚀 وارف شغال على ${port}`);
    await getSallaToken();
});
