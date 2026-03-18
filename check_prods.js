const fs = require('fs');
require('dotenv').config();
const { getProducts } = require('./services/database');

async function check() {
    try {
        const prods = await getProducts();
        console.log("Found", prods.length, "products.");
        prods.forEach(p => {
            console.log(`- [${p.id}] ${p.name}: image_url = ${p.image_url}`);
        });
    } catch (e) {
        console.error("Error checking products:", e.message);
    }
}

check();
