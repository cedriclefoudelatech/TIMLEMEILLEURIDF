
const { SETTINGS_DEFAULTS } = require('./services/database');
const { supabase } = require('./config/supabase');

async function migrateSettings() {
    console.log("🚀 Starting settings migration...");

    // 1. Get current columns of bot_settings
    const { data: cols, error: colError } = await supabase.rpc('get_table_columns', { table_name: 'bot_settings' });

    // If RPC fails, we'll try a different approach: fetch one row and check its keys
    let existingCols = [];
    if (colError) {
        console.warn("⚠️ RPC get_table_columns failed, trying select * approach...");
        const { data, error } = await supabase.from('bot_settings').select('*').limit(1);
        if (error) {
            console.error("❌ Failed to fetch bot_settings schema:", error.message);
            return;
        }
        existingCols = data && data.length > 0 ? Object.keys(data[0]) : [];
    } else {
        existingCols = cols.map(c => c.column_name);
    }

    console.log(`📊 Found ${existingCols.length} columns in bot_settings.`);

    // 2. Identify missing columns from SETTINGS_DEFAULTS
    const missing = [];
    for (const key in SETTINGS_DEFAULTS) {
        if (!existingCols.includes(key)) {
            missing.push(key);
        }
    }

    if (missing.length === 0) {
        console.log("✨ No missing columns in bot_settings!");
    } else {
        console.log(`🔎 Found ${missing.length} missing columns:`, missing.join(', '));

        // 3. Generate ALTER TABLE statements
        // We assume all settings are TEXT by default unless they are BOOLEAN or NUMERIC in defaults
        let sql = `-- MIGRATION: ADD MISSING SETTINGS COLUMNS\n`;
        for (const key of missing) {
            const val = SETTINGS_DEFAULTS[key];
            let type = 'TEXT';
            let def = "NULL";

            if (typeof val === 'boolean') {
                type = 'BOOLEAN';
                def = val ? 'true' : 'false';
            } else if (typeof val === 'number') {
                type = 'NUMERIC';
                def = val.toString();
            } else if (Array.isArray(val) || typeof val === 'object') {
                type = 'JSONB';
                def = "'[]'::jsonb";
            } else if (val === null) {
                type = 'TEXT';
                def = "NULL";
            } else {
                type = 'TEXT';
                def = `'${val.replace(/'/g, "''")}'`;
            }

            sql += `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ${key} ${type} DEFAULT ${def};\n`;
        }

        console.log("\n📜 Generated SQL:\n" + sql);

        // Note: We can't run raw SQL directly through the client easily without an RPC or postgres extension
        // But we can try to save it to a file for the user.
        const fs = require('fs');
        fs.writeFileSync('migration_settings_repair.sql', sql);
        console.log("✅ Migration script saved to 'migration_settings_repair.sql'");
    }
}

migrateSettings();
