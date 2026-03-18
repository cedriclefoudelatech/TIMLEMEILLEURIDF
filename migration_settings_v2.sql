-- Add payment_modes_config and other missing customizable messages to bot_settings
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS payment_modes_config jsonb DEFAULT '[{"id": "CASH", "label": "Espèces", "icon": "💵"}, {"id": "CARD", "label": "Carte Bancaire", "icon": "💳"}]'::jsonb;

-- Ensure all current bot texts are columns if they are not yet
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_order_received_admin text;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_order_confirmed_client text;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS btn_livreur_space text DEFAULT '🛵 Espace Livreur';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS btn_back_menu text DEFAULT '◀️ Retour Menu';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_status_taken text;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_status_delivered text;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_delay_report text;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_arrival_soon text;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_review_prompt text;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_review_thanks text;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS btn_leave_review text DEFAULT '✍️ Laisser un avis';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS btn_view_reviews text DEFAULT '⭐️ Consulter les avis';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS btn_confirm_review text DEFAULT 'Confirmer la note';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS btn_back_menu_nav text DEFAULT '◀️ Retour Menu';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS btn_cart_resume text DEFAULT '🛒 Reprendre Panier';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS btn_client_mode text DEFAULT '👤 Mode Client';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_thanks_participation text DEFAULT 'Merci pour votre participation !';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_your_answer text DEFAULT 'Votre réponse :';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS default_wa_name text DEFAULT 'Utilisateur WhatsApp';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS enable_abandoned_cart_notifications boolean DEFAULT true;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS msg_abandoned_cart text;
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS label_reviews text DEFAULT 'Avis';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS label_users text DEFAULT 'Utilisateurs';
