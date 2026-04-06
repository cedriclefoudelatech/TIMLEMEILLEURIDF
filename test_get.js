const { getProducts } = require('./services/database');
async function run() {
  const products = await getProducts();
  console.log('Returned products count:', products.length);
  console.log('Returned products:', products.map(p => p.name));
}
run();
