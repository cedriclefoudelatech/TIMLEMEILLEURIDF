require('dotenv').config();

(async () => {
    try {
        const { getProducts, getAppSettings } = require('./services/database');

        console.log('=== Testing database access ===');
        const settings = await getAppSettings();
        console.log('Settings loaded:', Boolean(settings), 'bot_name:', settings && settings.bot_name);

        const products = await getProducts();
        console.log('Products count:', products && products.length);
        if (products && products.length > 0) {
            products.forEach((p, i) => {
                const imgUrl = p.image_url ? p.image_url.substring(0, 80) : 'NULL';
                console.log('  Product ' + i + ':', JSON.stringify({ id: p.id, name: p.name, price: p.price, image_url: imgUrl }));
            });
        }

        // Simulate qty handler
        if (products && products.length > 0) {
            const product = products[0];
            const qty = 1;
            console.log('\n=== Simulating qty handler ===');
            console.log('Product:', product.name, 'Price:', product.price);
            console.log('Has discounts:', product.has_discounts);
            console.log('Image URL full:', product.image_url || 'NONE');

            let totalPriceValue = product.price * qty;
            console.log('Total price:', totalPriceValue.toFixed(2));

            // Check if image_url would cause issues in safeEdit
            const photo = product.image_url;
            if (photo && typeof photo === 'string') {
                const isUrl = photo.startsWith('http');
                const isFileId = photo && !photo.includes('/') && !photo.includes('.');
                const isRelative = !isUrl && !isFileId;
                console.log('\nPhoto analysis:', { isUrl, isFileId, isRelative, length: photo.length });

                if (isRelative) {
                    const path = require('path');
                    const fs = require('fs');
                    const relativePath = photo.startsWith('/public/') ? photo.replace('/public/', 'web/public/') : photo;
                    const absolutePath = path.resolve(process.cwd(), relativePath.startsWith('/') ? relativePath.substring(1) : relativePath);
                    console.log('Absolute path would be:', absolutePath);
                    console.log('File exists:', fs.existsSync(absolutePath));

                    const baseUrl = (settings.dashboard_url || '').replace(/\/$/, '');
                    console.log('Dashboard URL:', baseUrl);
                    const fullUrl = baseUrl + (photo.startsWith('/') ? '' : '/') + photo;
                    console.log('Full URL would be:', fullUrl);
                }
            } else {
                console.log('\nNo photo for this product');
            }
        }

        process.exit(0);
    } catch(e) {
        console.error('ERROR:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
})();
