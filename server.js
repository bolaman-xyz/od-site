const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

const SELLAUTH_API_KEY = process.env.SELLAUTH_API_KEY;
const SELLAUTH_SHOP_ID = process.env.SELLAUTH_SHOP_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const SITE_URL = process.env.SITE_URL || '';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'config.json');

function loadData() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { products: {}, guides: {} }; } }
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

const sessions = new Map();

function authMiddleware(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
    req.session = sessions.get(token);
    next();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Discord OAuth
app.get('/auth/discord', (req, res) => {
    const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20email`;
    res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    try {
        // Exchange code for token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: DISCORD_REDIRECT_URI
            })
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return res.redirect('/?error=auth_failed');

        // Get Discord user
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        const user = await userRes.json();

        const sessionToken = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionToken, {
            type: 'user',
            discord_id: user.id,
            username: user.username,
            global_name: user.global_name || user.username,
            avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
            email: user.email,
            created: Date.now()
        });

        res.redirect(`/dashboard.html#token=${sessionToken}`);
    } catch (err) {
        console.error('Discord OAuth error:', err);
        res.redirect('/?error=server_error');
    }
});

// Get current user session
app.get('/api/me', authMiddleware, (req, res) => {
    res.json(req.session);
});

// Lookup customer products by email
app.get('/api/my-products', authMiddleware, async (req, res) => {
    const email = req.session.email;
    if (!email) return res.json({ products: [], message: 'No email linked' });

    try {
        // Search invoices by email
        const invoiceRes = await fetch(`https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/invoices?page=1&perPage=100`, {
            headers: { 'Authorization': `Bearer ${SELLAUTH_API_KEY}`, 'Content-Type': 'application/json' }
        });
        const invoiceData = await invoiceRes.json();
        const invoices = invoiceData.data || invoiceData || [];

        // Filter invoices by customer email
        const userInvoices = Array.isArray(invoices) ? invoices.filter(inv =>
            inv.customer_email?.toLowerCase() === email.toLowerCase() ||
            inv.email?.toLowerCase() === email.toLowerCase()
        ) : [];

        // Get all products for reference
        const prodRes = await fetch(`https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/products?page=1&perPage=100`, {
            headers: { 'Authorization': `Bearer ${SELLAUTH_API_KEY}`, 'Content-Type': 'application/json' }
        });
        const prodData = await prodRes.json();
        const allProducts = prodData.data || prodData || [];

        // Load admin overrides
        const config = loadData();

        // Match purchased products
        const purchasedProducts = [];
        const seenIds = new Set();

        for (const inv of userInvoices) {
            const items = inv.items || inv.products || [inv];
            for (const item of items) {
                const pid = item.product_id || item.id;
                if (pid && !seenIds.has(pid)) {
                    seenIds.add(pid);
                    const product = Array.isArray(allProducts) ? allProducts.find(p => p.id === pid) : null;
                    const override = config.products?.[String(pid)] || {};
                    purchasedProducts.push({
                        ...(product || {}),
                        ...override,
                        _id: pid,
                        invoice_id: inv.id,
                        purchased_at: inv.created_at || inv.paid_at,
                        delivered: inv.delivered || inv.status === 'completed',
                        deliverables: item.deliverables || inv.deliverables || null
                    });
                }
            }
        }

        res.json({ products: purchasedProducts, total_invoices: userInvoices.length });
    } catch (err) {
        console.error('Product lookup error:', err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// Lookup by email (manual entry)
app.post('/api/lookup', authMiddleware, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Update session email
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (session) session.email = email;

    // Re-fetch with new email
    try {
        const invoiceRes = await fetch(`https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/invoices?page=1&perPage=100`, {
            headers: { 'Authorization': `Bearer ${SELLAUTH_API_KEY}`, 'Content-Type': 'application/json' }
        });
        const invoiceData = await invoiceRes.json();
        const invoices = invoiceData.data || invoiceData || [];

        console.log('Lookup email:', email);
        console.log('Total invoices from API:', Array.isArray(invoices) ? invoices.length : 'not array');
        if (Array.isArray(invoices) && invoices.length > 0) {
            console.log('First invoice keys:', Object.keys(invoices[0]));
            console.log('First invoice sample:', JSON.stringify(invoices[0]).substring(0, 500));
        }

        const emailLower = email.toLowerCase();
        const userInvoices = Array.isArray(invoices) ? invoices.filter(inv => {
            const ce = inv.customer_email || inv.email || inv.customer?.email || '';
            return ce.toLowerCase() === emailLower;
        }) : [];

        console.log('Matched invoices:', userInvoices.length);

        const prodRes = await fetch(`https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/products?page=1&perPage=100`, {
            headers: { 'Authorization': `Bearer ${SELLAUTH_API_KEY}`, 'Content-Type': 'application/json' }
        });
        const prodData = await prodRes.json();
        const allProducts = prodData.data || prodData || [];
        const config = loadData();

        const purchasedProducts = [];
        const seenIds = new Set();
        for (const inv of userInvoices) {
            const items = inv.items || inv.products || [inv];
            for (const item of items) {
                const pid = item.product_id || item.id;
                if (pid && !seenIds.has(pid)) {
                    seenIds.add(pid);
                    const product = Array.isArray(allProducts) ? allProducts.find(p => p.id === pid) : null;
                    const override = config.products?.[String(pid)] || {};
                    purchasedProducts.push({ ...(product || {}), ...override, _id: pid });
                }
            }
        }

        console.log('Products found:', purchasedProducts.length);
        res.json({ products: purchasedProducts, total_invoices: userInvoices.length });
    } catch (err) {
        console.error('Lookup error:', err);
        res.status(500).json({ error: 'Failed to lookup' });
    }
});

// Public products list
app.get('/api/products', async (req, res) => {
    try {
        const resp = await fetch(`https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/products?page=1&perPage=100`, {
            headers: { 'Authorization': `Bearer ${SELLAUTH_API_KEY}`, 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        const config = loadData();
        const products = data.data || data.products || data || [];
        const merged = Array.isArray(products) ? products.map(p => {
            const override = config.products?.[String(p.id)] || {};
            return { ...p, ...override, _id: p.id };
        }) : [];
        res.json({ data: merged });
    } catch (err) {
        console.error('SellAuth API error:', err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// Admin endpoints
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { type: 'admin', created: Date.now() });
    res.json({ token });
});

app.get('/api/admin/config', authMiddleware, (req, res) => {
    if (req.session.type !== 'admin') return res.status(403).json({ error: 'Not admin' });
    res.json(loadData());
});

app.put('/api/admin/product/:id', authMiddleware, (req, res) => {
    if (req.session.type !== 'admin') return res.status(403).json({ error: 'Not admin' });
    const data = loadData();
    if (!data.products) data.products = {};
    data.products[req.params.id] = { ...data.products[req.params.id], ...req.body };
    saveData(data);
    res.json({ ok: true });
});

app.delete('/api/admin/product/:id', authMiddleware, (req, res) => {
    if (req.session.type !== 'admin') return res.status(403).json({ error: 'Not admin' });
    const data = loadData();
    if (data.products) delete data.products[req.params.id];
    saveData(data);
    res.json({ ok: true });
});

app.put('/api/admin/guide/:slug', authMiddleware, (req, res) => {
    if (req.session.type !== 'admin') return res.status(403).json({ error: 'Not admin' });
    const data = loadData();
    if (!data.guides) data.guides = {};
    data.guides[req.params.slug] = req.body;
    saveData(data);
    res.json({ ok: true });
});

app.get('/api/guides', (req, res) => { res.json(loadData().guides || {}); });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Running on port ${PORT}`));
