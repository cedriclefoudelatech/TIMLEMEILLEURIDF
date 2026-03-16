#!/usr/bin/env node
/**
 * Utilitaire pour générer une clé de licence à partir de l'URL Supabase.
 * Usage: node generate-license.js https://votre-projet.supabase.co
 */
const { generateLicense } = require('./services/license');

const url = process.argv[2];
if (!url) {
    console.error('Usage: node generate-license.js <SUPABASE_URL>');
    process.exit(1);
}

const key = generateLicense(url);
console.log(`\nURL Supabase : ${url}`);
console.log(`Clé licence  : ${key}`);
console.log(`\nAjoutez dans votre .env :`);
console.log(`LICENSE_KEY=${key}`);
