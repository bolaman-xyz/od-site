const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

const SELLAUTH_API_KEY = process.env.SELLAUTH_API_KEY;
const SELLAUTH_SHOP_ID = process.env.SELLAUTH_SHOP_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_FILE = path.join(DATA_DIR, 'config.json');

function loadData() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
        return { products: {}, guides: {} };
    }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const sessions = new Map();

function authMiddleware(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { created: Date.now() });
    res.json({ token });
});

app.post('/api/admin/logout', (req, res) => {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (token) sessions.delete(token);
    res.json({ ok: true });
});

// SellAuth products
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

// Admin: get config
app.get('/api/admin/config', authMiddleware, (req, res) => {
    res.json(loadData());
});

// Admin: update product override
app.put('/api/admin/product/:id', authMiddleware, (req, res) => {
    const data = loadData();
    if (!data.products) data.products = {};
    data.products[req.params.id] = { ...data.products[req.params.id], ...req.body };
    saveData(data);
    res.json({ ok: true });
});

// Admin: delete product override
app.delete('/api/admin/product/:id', authMiddleware, (req, res) => {
    const data = loadData();
    if (data.products) delete data.products[req.params.id];
    saveData(data);
    res.json({ ok: true });
});

// Admin: update guide
app.put('/api/admin/guide/:slug', authMiddleware, (req, res) => {
    const data = loadData();
    if (!data.guides) data.guides = {};
    data.guides[req.params.slug] = req.body;
    saveData(data);
    res.json({ ok: true });
});

// Admin: get guides
app.get('/api/guides', (req, res) => {
    const data = loadData();
    res.json(data.guides || {});
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'downloads.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Running on port ${PORT}`));
