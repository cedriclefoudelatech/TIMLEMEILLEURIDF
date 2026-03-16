const crypto = require('crypto');
require('dotenv').config({ path: process.env.RAILWAY_ENVIRONMENT ? '.env.railway' : '.env' });

// Master key fragments — assembled at runtime to discourage simple grep
const _p = ['4f7a', '9c3d', 'b8e1', '2d6f', 'a5c8', '71e3', '0b9d', 'f4a2'];
const _s = () => _p.reduce((a, b) => a + b, '');

function _hmac(data) {
    return crypto.createHmac('sha256', _s()).update(data).digest('hex');
}

/**
 * Generate a license key for a given Supabase URL.
 * Called only from the private CLI tool (generate-license.js).
 */
function generateLicense(supabaseUrl) {
    if (!supabaseUrl) throw new Error('URL Supabase requise');
    const normalized = supabaseUrl.replace(/\/+$/, '').toLowerCase();
    return _hmac(normalized);
}

/**
 * Validate the license from environment variables.
 * Returns true if LICENSE_KEY matches the HMAC of SUPABASE_URL.
 */
function validateLicense() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.LICENSE_KEY;
    if (!url || !key) return false;
    const normalized = url.replace(/\/+$/, '').toLowerCase();
    const expected = _hmac(normalized);
    return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(expected, 'hex'));
}

module.exports = { generateLicense, validateLicense };
