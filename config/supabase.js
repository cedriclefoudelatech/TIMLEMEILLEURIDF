const { createClient } = require('@supabase/supabase-js');
const { validateLicense } = require('../services/license');
require('dotenv').config({ path: process.env.RAILWAY_ENVIRONMENT ? '.env.railway' : '.env' });

if (!validateLicense()) {
    console.error('❌ Licence invalide.');
    process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = { supabase };
