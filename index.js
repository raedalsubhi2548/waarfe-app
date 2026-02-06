require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const SALLA_API = 'https://api.salla.dev/admin/v2';
const SALLA_CID = process.env.SALLA_CLIENT_ID;
const SALLA_CS = process.env.SALLA_CLIENT_SECRET;
const ANTH_KEY = process.env.ANTHROPIC_API_KEY;

let sToken = null, sExp = 0;

async function getToken() {
    if (sToken && Date.now() < sExp) return sToken;
    try {
        const r = await axios.post('https://accounts.salla.dev/oauth2/token', {
            client_id: SALLA_CID, client_secret: SALLA_CS, grant_type: 'client_credentials'
        }, { headers: { 'Content-Type': 'application/json' } });
        sToken = r.data.access_token;
        sExp = Date.now() + ((r.data.expires_in || 3600) - 300) * 1000;
        console.log('✅ توكن سلة جاهز');
        return sToken;
    } catch (e) {
        console.error('❌ توكن سلة:', e.message);
        return null;
    }
}

async function getOrder(num) {
    await getToken();
    if (!sToken) return null;
    try {
        const r = await axios.get(`${SALLA_API}/orders`, {
            headers: { Authorization: `Bearer ${sToken}` },
            params: { search: num }
        });
        const o = r.data.data || [];
        return o.length ? o[0] : null;
    } catch (e) {
        console.error('❌ طلب:', e.message);
        return null;
    }
}

function extractOrder(text) {
    if (!text) return null;
    const pats = [
        /(?:رقم\s*طلب(?:ي)?|طلب\s*(?:رقم|#)?|رقم\s*(?:ال)?طلب|order\s*#?\s*|#)\s*(\d{4,})/i,
        /(?:طلبي|طلب)\s+(\d{4,})/i,
        /(?:متابعة|تتبع|حالة)\s+(?:طلب\s*)?#?\s*(\d{4,})/i,
    ];
    for (const p of pats) { const m = text.match(p); if (m) return m[1]; }
    if (/طلب|order|متابعة|تتبع|حالة/i.test(text)) {
        const m = text.match(/\b(\d{5,})\b/);
        if (m) return m[1];
    }
    return null;
}

function getQR(msg, order) {
    if (order) return ['متابعة الطلب', 'التواصل مع الدعم', 'سياسة الاسترجاع'];
    if (/خدم|سعر|تكلف|كم|باقة|عرض|اسعار/i.test(msg)) return ['وش المتطلبات؟', 'مدة التنفيذ', 'طريقة التسليم'];
    if (/طلب|متابع|تتبع/i.test(msg)) return ['متابعة الطلب', 'التواصل مع الدعم'];
    return null;
}

function sysPrompt(url, title, excerpt) {
    return `أنت مساعد وارف — تتكلم مع العميل كأنك صاحبه، بلهجة سعودية عفوية ومحترمة.

شخصيتك:
- ردودك قصيرة ومباشرة (سطرين لـ 4 بالكثير)
- ادخل بالموضوع بدون مقدمات
- لو تحتاج معلومة، اسأل سؤال واحد واضح
- إيموجي خفيف (1-2 بس لو يناسب)

قواعد:
1. كل معلوماتك عن الخدمات والأسعار من المحتوى تحت فقط. لا تخترع شي مو موجود.
2. لا تقول أبداً: "بناء على الصفحة" أو "حسب المعلومات المتوفرة" أو "المحتوى يذكر" أو أي عبارة تبيّن إنك تقرأ من مصدر. تكلم طبيعي وكأنك تعرف المعلومة من راسك.
3. لو ما تعرف: اسأل سؤال يوضح، أو قل بعفوية "هالشي أفضل تتواصل فيه مع الفريق مباشرة وبيساعدونك 😊"
4. لا ترحب بكل رد. ادخل بالفايدة.
5. نقاط (•) بس لو عندك 3+ أشياء تسردها.

المحتوى:
عنوان: ${title || ''}
${excerpt || 'لا يوجد'}`;
}

async function askAI(msg, sp) {
    try {
        const r = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-haiku-20240307',
            max_tokens: 350,
            temperature: 0.3,
            system: sp,
            messages: [{ role: 'user', content: msg }]
        }, {
            headers: {
                'x-api-key': ANTH_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            }
        });
        return r.data.content[0].text;
    } catch (e) {
        console.error('❌ AI:', e.response?.data || e.message);
        return 'عذراً صار خطأ، جرب مرة ثانية أو كلم الدعم 🙏';
    }
}

function fmtOrder(o) {
    const s = o.status?.name || o.status || 'غير محدد';
    const t = o.total ? ` 💰 المبلغ: ${o.total} ريال` : '';
    return `طلبك #${o.id} حالته: ${s}${t}\n\nتحتاج شي ثاني؟ 😊`;
}

app.post('/api/chat', async (req, res) => {
    const { message, page_url, page_title, page_excerpt } = req.body;
    if (!message?.trim()) return res.json({ reply: 'هلا! وش تبي تعرف؟ 😊' });

    const msg = message.trim();
    console.log('📩', msg);

    const oNum = extractOrder(msg);
    if (oNum) {
        console.log('🔍 طلب:', oNum);
        const o = await getOrder(oNum);
        if (o) return res.json({ reply: fmtOrder(o), quick_replies: getQR(msg, true) });
        return res.json({
            reply: `ما لقيت طلب بالرقم ${oNum} 🤔\nتأكد من الرقم وجرب مرة ثانية`,
            quick_replies: ['التواصل مع الدعم', 'متابعة الطلب']
        });
    }

    const sp = sysPrompt(page_url, page_title, page_excerpt);
    const reply = await askAI(msg, sp);
    return res.json({ reply, quick_replies: getQR(msg, false) });
});

app.get('/', (req, res) => {
    res.send('<html dir="rtl"><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>🤖 سيرفر وارف شغال!</h1></body></html>');
});

app.listen(port, async () => {
    console.log(`🚀 وارف على ${port}`);
    await getToken();
});
