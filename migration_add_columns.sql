-- =====================================================================
-- MIGRATION : Ajout des colonnes manquantes
-- À exécuter dans l'éditeur SQL de Supabase (Project > SQL Editor)
-- =====================================================================

-- ---------------------------------------------------------------
-- 1. TABLE bot_settings — colonnes nouvellement ajoutées
-- ---------------------------------------------------------------

ALTER TABLE bot_settings
    ADD COLUMN IF NOT EXISTS btn_back_menu            TEXT    DEFAULT '◀️ Retour Menu',
    ADD COLUMN IF NOT EXISTS btn_back_menu_nav        TEXT    DEFAULT '◀️ Retour Menu',
    ADD COLUMN IF NOT EXISTS label_livreur            TEXT    DEFAULT 'Espace Livreur',
    ADD COLUMN IF NOT EXISTS msg_welcome_back         TEXT    DEFAULT '',
    ADD COLUMN IF NOT EXISTS msg_order_notif_livreur  TEXT    DEFAULT '',
    ADD COLUMN IF NOT EXISTS ui_icon_leave_review     TEXT    DEFAULT '⭐️',
    ADD COLUMN IF NOT EXISTS ui_icon_view_reviews     TEXT    DEFAULT '👥',
    ADD COLUMN IF NOT EXISTS btn_cart_resume          TEXT    DEFAULT '➡️ 🛒 REPRENDRE MON PANIER',
    ADD COLUMN IF NOT EXISTS btn_client_mode          TEXT    DEFAULT '🛒 Mode Client (commander)',
    ADD COLUMN IF NOT EXISTS btn_livreur_space        TEXT    DEFAULT '🚴 Espace Livreur',
    ADD COLUMN IF NOT EXISTS msg_order_confirmed_client TEXT  DEFAULT '',
    ADD COLUMN IF NOT EXISTS msg_order_received_admin TEXT    DEFAULT '',
    ADD COLUMN IF NOT EXISTS msg_status_taken         TEXT    DEFAULT '🚚 Votre commande est en route !',
    ADD COLUMN IF NOT EXISTS msg_status_delivered     TEXT    DEFAULT '✅ Livraison confirmée ! Merci pour votre commande.',
    ADD COLUMN IF NOT EXISTS msg_delay_report         TEXT    DEFAULT '⏳ Un retard est à signaler pour votre commande.',
    ADD COLUMN IF NOT EXISTS msg_arrival_soon         TEXT    DEFAULT '🛵 Votre livreur arrive bientôt !',
    ADD COLUMN IF NOT EXISTS msg_review_prompt        TEXT    DEFAULT '⭐ Êtes-vous satisfait de votre commande ?',
    ADD COLUMN IF NOT EXISTS msg_review_thanks        TEXT    DEFAULT '🙏 Merci pour votre avis !',
    ADD COLUMN IF NOT EXISTS msg_thanks_participation TEXT    DEFAULT 'Merci pour votre participation !',
    ADD COLUMN IF NOT EXISTS msg_your_answer          TEXT    DEFAULT 'Votre réponse',
    ADD COLUMN IF NOT EXISTS btn_leave_review         TEXT    DEFAULT '⭐ Laisser un avis',
    ADD COLUMN IF NOT EXISTS btn_view_reviews         TEXT    DEFAULT '👥 Voir les avis',
    ADD COLUMN IF NOT EXISTS btn_confirm_review       TEXT    DEFAULT '✅ Confirmer',
    ADD COLUMN IF NOT EXISTS label_support            TEXT    DEFAULT 'Aide & Support',
    ADD COLUMN IF NOT EXISTS ui_icon_support          TEXT    DEFAULT '❓',
    ADD COLUMN IF NOT EXISTS label_reviews            TEXT    DEFAULT 'Avis',
    ADD COLUMN IF NOT EXISTS label_users              TEXT    DEFAULT 'Utilisateurs',
    ADD COLUMN IF NOT EXISTS label_catalog_title      TEXT    DEFAULT '',
    ADD COLUMN IF NOT EXISTS label_info               TEXT    DEFAULT 'Informations',
    ADD COLUMN IF NOT EXISTS welcome_photo            TEXT    DEFAULT '',
    ADD COLUMN IF NOT EXISTS accent_color             TEXT    DEFAULT '#4CAF50',
    ADD COLUMN IF NOT EXISTS languages                TEXT    DEFAULT 'fr',
    ADD COLUMN IF NOT EXISTS payment_modes_config     TEXT    DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS default_wa_name          TEXT    DEFAULT 'Utilisateur',
    ADD COLUMN IF NOT EXISTS enable_abandoned_cart_notifications BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS msg_abandoned_cart       TEXT    DEFAULT '';

-- ---------------------------------------------------------------
-- 2. TABLE bot_products — colonnes pour remises et bundles
-- ---------------------------------------------------------------

ALTER TABLE bot_products
    ADD COLUMN IF NOT EXISTS has_discounts    BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS discounts_config JSONB   DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS is_bundle        BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS bundle_config    JSONB   DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------
-- 3. TABLE bot_reviews — colonnes pour les médias multiples
--    (si la colonne "photos" est de type TEXT[], sinon JSONB)
-- ---------------------------------------------------------------

ALTER TABLE bot_reviews
    ADD COLUMN IF NOT EXISTS photos TEXT[] DEFAULT '{}';

-- ---------------------------------------------------------------
-- Vérification : liste les colonnes après migration
-- ---------------------------------------------------------------

SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name IN ('bot_settings', 'bot_products', 'bot_reviews')
ORDER BY table_name, ordinal_position;
