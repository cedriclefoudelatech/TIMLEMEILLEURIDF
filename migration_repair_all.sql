-- ============================================================
-- MIGRATION DE RÉPARATION : AJOUT DES COLONNES MANQUANTES
-- ============================================================

-- 1. Table bot_settings
-- On ajoute les colonnes qui manquent souvent selon SETTINGS_DEFAULTS et l'erreur constatée
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS label_broadcasts TEXT DEFAULT 'Informations';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS label_leave_review TEXT DEFAULT 'Laisser un avis';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS label_view_reviews TEXT DEFAULT 'Consulter les avis';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS show_broadcasts_btn BOOLEAN DEFAULT true;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS show_reviews_btn BOOLEAN DEFAULT true;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ui_icon_review TEXT DEFAULT '⭐️';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ui_icon_reviews_list TEXT DEFAULT '👥';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ui_icon_info TEXT DEFAULT 'ℹ️';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS msg_auto_timer TEXT DEFAULT '🔥 <b>Le catalogue est à jour !</b>';

-- Vérification et ajout d'autres colonnes de bot_settings si nécessaire
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS fidelity_bonus_thresholds TEXT DEFAULT '5,10,15,20';
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS fidelity_bonus_amount NUMERIC DEFAULT 10;
ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS points_credit_value NUMERIC DEFAULT 10;

-- 2. Table bot_orders
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS notified_5m BOOLEAN DEFAULT false;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS notified_10m BOOLEAN DEFAULT false;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS delay_reason TEXT;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS client_reply TEXT;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS chat_count NUMERIC DEFAULT 0;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS help_requests JSONB DEFAULT '[]'::jsonb;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS notif_1h_sent BOOLEAN DEFAULT false;
ALTER TABLE bot_orders ADD COLUMN IF NOT EXISTS notif_30m_sent BOOLEAN DEFAULT false;

-- 3. Table bot_users
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS current_city TEXT DEFAULT 'non défini';
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}'::jsonb;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT false;

-- 4. Table bot_products
ALTER TABLE bot_products ADD COLUMN IF NOT EXISTS is_bundle BOOLEAN DEFAULT false;
ALTER TABLE bot_products ADD COLUMN IF NOT EXISTS bundle_config JSONB DEFAULT '{}'::jsonb;
ALTER TABLE bot_products ADD COLUMN IF NOT EXISTS unit_value TEXT;

-- 5. Table bot_daily_stats
ALTER TABLE bot_daily_stats ADD COLUMN IF NOT EXISTS orders NUMERIC DEFAULT 0;
ALTER TABLE bot_daily_stats ADD COLUMN IF NOT EXISTS revenue NUMERIC DEFAULT 0;

-- Force le rechargement du schéma (en ajoutant un commentaire bidon)
COMMENT ON TABLE bot_settings IS 'Table des paramètres du bot (Mise à jour du schéma effectuée)';
