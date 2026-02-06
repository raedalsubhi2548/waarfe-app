require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const SALLA_API_BASE = 'https://api.salla.dev/admin/v2';
const SALLA_CLIENT_ID = process.env.SALLA_CLIENT_ID;
const SALLA_CLIENT_SECRET = process.env.SALLA_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SALLA_STORE_DOMAIN = process.env.SALLA_STORE_DOMAIN;

let sallaAccessToken = null;

async function getSallaAccessToken() {
    try {
        const response = await axios.post('https://accounts.salla.dev/oauth2/token', {
            client_id: SALLA_CLIENT_ID,
            client_secret: SALLA_CLIENT_SECRET,
            grant_type: 'client_credentials'
        }, {
            headers: { 'Content-Type': 'application/json' }
        });
        sallaAccessToken = response.data.access_token;
        console.log('✅ تم الحصول على توكن صلة');
        return sallaAccessToken;
    } catch (error) {
        console.error('❌ فشل في الحصول على توكن صلة:', error.message);
        return null;
    }
}

async function getOrderByNumber(orderNumber) {
    if (!sallaAccessToken) await getSallaAccessToken();
    try {
        const response = await axios.get(`${SALLA_API_BASE}/orders`, {
            headers: { 'Authorization': `Bearer ${sallaAccessToken}` },
            params: { search: orderNumber }
        });
        return response.data.data || [];
    } catch (error) {
        console.error('❌ خطأ في استرجاع الطلب:', error.message);
        return [];
    }
}

async function searchProducts(query) {
    if (!sallaAccessToken) await getSallaAccessToken();
    try {
        const response = await axios.get(`${SALLA_API_BASE}/products`, {
            headers: { 'Authorization': `Bearer ${sallaAccessToken}` },
            params: { search: query }
        });
        return response.data.data || [];
    } catch (error) {
        console.error('❌ خطأ في استرجاع المنتجات:', error.message);
        return [];
    }
}

async function askAI(userQuestion, context = '') {
    try {
        const prompt = `أنت مساعد متجر إلكتروني. تجيب بلغة عربية واضحة.
السياق: ${context}
سؤال العميل: ${userQuestion}
أجب بناءً على السياق إذا كان ذا صلة. إذا كان عن طلب، اذكر حالته. إذا كان عن منتج، قدم معلومات مفيدة.`;

        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-3-haiku-20240307',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }]
        }, {
            headers: {
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            }
        });
        return response.data.content[0].text;
    } catch (error) {
        console.error('❌ خطأ في الذكاء الاصطناعي:', error.message);
        return 'عذرًا، حدث خطأ. يرجى المحاولة لاحقًا.';
    }
}

app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    console.log(`📩 سؤال: ${userMessage}`);

    if (!userMessage) {
        return res.json({ reply: 'مرحبًا! كيف يمكنني مساعدتك؟' });
    }

    let orderInfo = '';
    const orderMatch = userMessage.match(/طلب رقم (\d+)|رقم الطلب (\d+)|(\d{5,})/);
    if (orderMatch) {
        const orderNumber = orderMatch[1] || orderMatch[2] || orderMatch[3];
        console.log(`🔍 بحث عن طلب: ${orderNumber}`);
        const orders = await getOrderByNumber(orderNumber);
        if (orders.length > 0) {
            const order = orders[0];
            orderInfo = `معلومات الطلب: رقم ${order.id}، الحالة: ${order.status.name || order.status}، المجموع: ${order.total} ريال.`;
        } else {
            orderInfo = `لم يتم العثور على طلب بالرقم ${orderNumber}.`;
        }
    }

    let productInfo = '';
    const productQuery = userMessage.includes('منتج') || userMessage.includes('أبحث عن') ? userMessage : '';
    if (productQuery) {
        const products = await searchProducts(productQuery);
        if (products.length > 0) {
            productInfo = `المنتجات: ${products.slice(0, 3).map(p => p.name).join(', ')}.`;
        }
    }

    const context = `${orderInfo} ${productInfo}`.trim();
    const aiReply = await askAI(userMessage, context);
    res.json({ reply: aiReply });
});

app.get('/', (req, res) => {
    res.send(`
        <html><body>
            <h1>🤖 سيرفر شات بوت المتجر يعمل!</h1>
            <p>لتجربة الشات، أرسل POST إلى <code>/api/chat</code></p>
        </body></html>
    `);
});

app.listen(port, async () => {
    console.log(`🚀 السيرفر يعمل على المنفذ: ${port}`);
    await getSallaAccessToken();
});
