const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

const SELLAUTH_API_KEY = process.env.SELLAUTH_API_KEY;
const SELLAUTH_SHOP_ID = process.env.SELLAUTH_SHOP_ID;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/products', async (req, res) => {
    try {
        const resp = await fetch(`https://api.sellauth.com/v1/shops/${SELLAUTH_SHOP_ID}/products?page=1&perPage=100`, {
            headers: {
                'Authorization': `Bearer ${SELLAUTH_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        const data = await resp.json();
        res.json(data);
    } catch (err) {
        console.error('SellAuth API error:', err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'downloads.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Running on port ${PORT}`));
