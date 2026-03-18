-- Migration: Système de Fournisseurs / Collaborateurs
-- Exécuter dans Supabase SQL Editor pour CHAQUE projet

-- === TABLE FOURNISSEURS ===
CREATE TABLE IF NOT EXISTS bot_suppliers (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name TEXT NOT NULL,
    telegram_id TEXT,
    phone TEXT,
    platform TEXT DEFAULT 'telegram',
    is_active BOOLEAN DEFAULT true,
    commission_pct NUMERIC DEFAULT 0,
    notes TEXT,
    created_at BIGINT DEFAULT (extract(epoch from now()) * 1000)::bigint
);

-- === LIEN PRODUIT → FOURNISSEUR ===
ALTER TABLE bot_products ADD COLUMN IF NOT EXISTS supplier_id TEXT;

-- === SUIVI COMMANDE FOURNISSEUR ===
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS supplier_id TEXT;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS supplier_notified BOOLEAN DEFAULT false;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS supplier_ready_at BIGINT;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS supplier_prep_time TEXT;

-- === SETTINGS POUR FOURNISSEURS ===
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_supplier_new_order TEXT DEFAULT '📦 <b>Nouvelle commande !</b>';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_supplier_ready TEXT DEFAULT '✅ Produit prêt pour livraison !';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_supplier_ready TEXT DEFAULT '✅ Prêt à livrer';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_supplier_prep_time TEXT DEFAULT '⏱ Temps de préparation';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_supplier_my_sales TEXT DEFAULT '📊 Mes ventes';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS btn_supplier_menu TEXT DEFAULT '🏪 Espace Fournisseur';
