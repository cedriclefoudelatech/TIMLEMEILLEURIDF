-- ============================================================
-- MIGRATION: FINAL SYNC TIM LE MEILLEUR IDF (v3)
-- Alligns settings with TIM LE MEILLEUR IDF robust system
-- ============================================================

-- 1. Ajout des colonnes de contrôle des modules dans bot_settings
-- Ces colonnes permettent d'activer/désactiver les fonctionnalités via le bot
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS enable_telegram boolean DEFAULT true;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS enable_whatsapp boolean DEFAULT true;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS enable_marketplace boolean DEFAULT true;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS enable_fidelity boolean DEFAULT true;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS enable_referral boolean DEFAULT true;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS auto_approve_new boolean DEFAULT false;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS notify_on_approval boolean DEFAULT false;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS priority_delivery_enabled boolean DEFAULT false;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS priority_delivery_price numeric DEFAULT 15;

-- 2. Indexation pour les performances du panneau Admin
-- Accélère la récupération des commandes et la liste des utilisateurs en attente
CREATE INDEX IF NOT EXISTS idx_bot_orders_status ON public.bot_orders(status);
CREATE INDEX IF NOT EXISTS idx_bot_users_is_approved ON public.bot_users(is_approved);
CREATE INDEX IF NOT EXISTS idx_bot_users_is_blocked ON public.bot_users(is_blocked);

-- 3. Mise à jour des paramètres par défaut (Optionnel)
UPDATE public.bot_settings 
SET auto_approve_new = false 
WHERE id = 'default' AND auto_approve_new IS NULL;

-- 4. Nettoyage (Si nécessaire)
-- Assure que tous les utilisateurs ont une valeur pour is_approved
UPDATE public.bot_users SET is_approved = true WHERE is_approved IS NULL;
UPDATE public.bot_users SET is_admin = false WHERE is_admin IS NULL;
UPDATE public.bot_users SET is_livreur = false WHERE is_livreur IS NULL;
