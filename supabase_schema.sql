-- ============================================================
-- SCHEMA COMPLET - TIM LE MEILLEUR IDF (Supabase)
-- ============================================================

-- ─────────────────────────────────────────
-- TABLE: bot_broadcasts
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_broadcasts (
  id                  text          NOT NULL,
  message             text,
  total_target        numeric       DEFAULT 0,
  success             numeric       DEFAULT 0,
  failed              numeric       DEFAULT 0,
  blocked             numeric       DEFAULT 0,
  target_platform     text,
  media_count         numeric       DEFAULT 0,
  status              text,
  created_at          timestamptz   DEFAULT now(),
  completed_at        text,
  previously_blocked  numeric       DEFAULT 0,
  blocked_names       text,
  start_at            timestamptz   DEFAULT now(),
  end_at              timestamptz,
  badge               text,
  poll_data           jsonb,
  CONSTRAINT bot_broadcasts_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────
-- TABLE: bot_daily_stats
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_daily_stats (
  id       text     NOT NULL,
  date     text,
  users    numeric  DEFAULT 0,
  orders   numeric  DEFAULT 0,
  revenue  numeric  DEFAULT 0,
  CONSTRAINT bot_daily_stats_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────
-- TABLE: bot_orders
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_orders (
  id               text          NOT NULL,
  user_id          text          NOT NULL,
  username         text,
  first_name       text,
  product_name     text,
  quantity         numeric,
  total_price      numeric,
  discount_applied numeric       DEFAULT 0,
  city             text,
  platform         text,
  status           text          DEFAULT 'pending'::text,
  points_awarded   boolean       DEFAULT false,
  livreur_id       text,
  created_at       timestamptz   DEFAULT now(),
  updated_at       timestamptz,
  delivered_at     timestamptz,
  notified_5m      boolean       DEFAULT false,
  notified_10m     boolean       DEFAULT false,
  address          text,
  scheduled_at     text,
  livreur_name     text,
  notif_1h_sent    boolean       DEFAULT false,
  notif_30m_sent   boolean       DEFAULT false,
  feedback_text    text,
  feedback_rating  numeric,
  chat_count       numeric       DEFAULT 0,
  delay_reason     text,
  client_reply     text,
  help_requests    jsonb         DEFAULT '[]'::jsonb,
  CONSTRAINT bot_orders_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────
-- TABLE: bot_products
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_products (
  id            text          NOT NULL,
  name          text          NOT NULL,
  price         numeric       NOT NULL,
  unit          text,
  promo         text,
  image_url     text,
  is_active     boolean       DEFAULT true,
  created_at    timestamptz   DEFAULT now(),
  unit_value    text,
  is_bundle     boolean       DEFAULT false,
  bundle_config jsonb         DEFAULT '{}'::jsonb,
  description   text,
  has_discounts boolean       DEFAULT false,
  discounts_config jsonb      DEFAULT '[]'::jsonb,
  CONSTRAINT bot_products_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────
-- TABLE: bot_referrals
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_referrals (
  id          text          NOT NULL,
  referrer_id text,
  referred_id text,
  created_at  timestamptz   DEFAULT now(),
  CONSTRAINT bot_referrals_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────
-- TABLE: bot_reviews
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_reviews (
  id         text          NOT NULL,
  user_id    text,
  username   text,
  first_name text,
  text       text,
  rating     integer,
  photos     jsonb         DEFAULT '[]'::jsonb,
  is_public  boolean       DEFAULT true,
  order_id   text,
  created_at timestamptz   DEFAULT now(),
  CONSTRAINT bot_reviews_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────
-- TABLE: bot_settings
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_settings (
  id                      text     NOT NULL,
  bot_name                text,
  dashboard_title         text,
  admin_telegram_id       text,
  admin_password          text,
  dashboard_url           text,
  welcome_message         text,
  accent_color            text,
  languages               text,
  points_ratio            numeric,
  points_exchange         numeric,
  ref_bonus               numeric,
  status_pending_label    text,
  status_taken_label      text,
  status_delivered_label  text,
  status_cancelled_label  text,
  label_profile           text,
  label_contact           text,
  label_livreur_space     text,
  label_welcome           text,
  label_catalog           text,
  label_admin_bot         text,
  label_channel           text,
  label_admin_web         text,
  label_my_orders         text,
  msg_choose_qty          text,
  msg_search_livreur      text,
  msg_order_success       text,
  ui_icon_catalog         text,
  ui_icon_web             text,
  ui_icon_stats           text,
  ui_icon_channel         text,
  ui_icon_livreur         text,
  ui_icon_pending         text,
  ui_icon_broadcast       text,
  ui_icon_logout          text,
  ui_icon_contact         text,
  ui_icon_notification    text,
  ui_icon_welcome         text,
  ui_icon_profile         text,
  ui_icon_wallet          text,
  ui_icon_error           text,
  ui_icon_admin           text,
  ui_icon_orders          text,
  ui_icon_success         text,
  ui_icon_points          text,
  ui_icon_taken           text     DEFAULT '🚀'::text,
  fidelity_bonus_thresholds text   DEFAULT '5,9,10'::text,
  fidelity_bonus_amount   numeric  DEFAULT 10,
  fidelity_wallet_max_pct numeric  DEFAULT 50,
  fidelity_min_spend      numeric  DEFAULT 0,
  channel_url             text,
  label_help              text     DEFAULT 'Aide / Support'::text,
  ui_icon_help            text     DEFAULT '❓'::text,
  msg_help_intro          text     DEFAULT 'Besoin d''aide ? Choisissez une option ci-dessous :'::text,
  private_contact_url     text,
  list_admins             jsonb    DEFAULT '[]'::jsonb,
  points_credit_value     numeric  DEFAULT 5,
  payment_modes           text,
  bot_description         text,
  bot_short_description   text,
  maintenance_mode        boolean  DEFAULT false,
  maintenance_message     text,
  maintenance_contact     text,
  label_broadcasts        text     DEFAULT 'Informations',
  label_leave_review      text     DEFAULT 'Laisser un avis',
  label_view_reviews      text     DEFAULT 'Consulter les avis',
  show_broadcasts_btn     boolean  DEFAULT true,
  show_reviews_btn        boolean  DEFAULT true,
  ui_icon_review          text     DEFAULT '⭐️',
  ui_icon_reviews_list    text     DEFAULT '👥',
  ui_icon_info            text     DEFAULT 'ℹ️',
  msg_auto_timer          text     DEFAULT '🔥 <b>Le catalogue est à jour !</b>',
  CONSTRAINT bot_settings_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────
-- TABLE: bot_stats
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_stats (
  id              text     NOT NULL,
  date            text,
  start_commands  numeric  DEFAULT 0,
  new_users       numeric  DEFAULT 0,
  total_orders    numeric  DEFAULT 0,
  total_users     numeric  DEFAULT 0,
  total_ca        numeric  DEFAULT 0,
  CONSTRAINT bot_stats_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────
-- TABLE: bot_users
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_users (
  id               text          NOT NULL,
  doc_id           text,
  platform         text,
  platform_id      text,
  type             text,
  username         text,
  first_name       text,
  last_name        text,
  language_code    text,
  is_active        boolean       DEFAULT true,
  is_blocked       boolean       DEFAULT false,
  is_livreur       boolean       DEFAULT false,
  is_admin         boolean       DEFAULT false,
  referred_by      text,
  referral_count   numeric       DEFAULT 0,
  order_count      numeric       DEFAULT 0,
  points           numeric       DEFAULT 0,
  wallet_balance   numeric       DEFAULT 0,
  referral_code    text,
  tracked_messages jsonb         DEFAULT '[]'::jsonb,
  last_menu_id     numeric,
  date_inscription timestamptz   DEFAULT now(),
  last_active      timestamptz,
  updated_at       timestamptz,
  blocked_at       timestamptz,
  is_available     boolean       DEFAULT false,
  current_city     text          DEFAULT 'non défini'::text,
  data             jsonb         DEFAULT '{}'::jsonb,
  CONSTRAINT bot_users_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────
-- TABLE: bot_state (persistance paniers, checkout, chats)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bot_state (
  id         text          NOT NULL,
  namespace  text          NOT NULL,
  user_key   text          NOT NULL,
  value      jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz   DEFAULT now(),
  updated_at timestamptz   DEFAULT now(),
  CONSTRAINT bot_state_pkey PRIMARY KEY (id)
);


-- ============================================================
-- INDEX
-- ============================================================

-- bot_orders
CREATE INDEX IF NOT EXISTS idx_delivered_orders
  ON public.bot_orders USING btree (status)
  WHERE (status = 'delivered'::text);

CREATE INDEX IF NOT EXISTS idx_orders_livreur_id
  ON public.bot_orders USING btree (livreur_id);

CREATE INDEX IF NOT EXISTS idx_orders_scheduled_at
  ON public.bot_orders USING btree (scheduled_at);

CREATE INDEX IF NOT EXISTS idx_orders_status
  ON public.bot_orders USING btree (status);

CREATE INDEX IF NOT EXISTS idx_orders_user_id
  ON public.bot_orders USING btree (user_id);

-- bot_reviews
CREATE INDEX IF NOT EXISTS idx_bot_reviews_public
  ON public.bot_reviews USING btree (is_public);

CREATE INDEX IF NOT EXISTS idx_bot_reviews_user_id
  ON public.bot_reviews USING btree (user_id);

-- bot_users
CREATE INDEX IF NOT EXISTS idx_users_platform_id
  ON public.bot_users USING btree (platform_id);

CREATE INDEX IF NOT EXISTS idx_users_search
  ON public.bot_users USING btree (username, first_name);

-- bot_state
CREATE INDEX IF NOT EXISTS idx_bot_state_namespace
  ON public.bot_state USING btree (namespace);


-- ============================================================
-- SEED: Configuration initiale TIM LE MEILLEUR IDF
-- ============================================================

INSERT INTO public.bot_settings (
  id,
  bot_name,
  dashboard_title,
  admin_telegram_id,
  admin_password,
  welcome_message,
  accent_color,
  languages,
  private_contact_url,
  channel_url,
  maintenance_message,
  maintenance_contact
) VALUES (
  'default',
  'TIM LE MEILLEUR IDF',
  'TIM LE MEILLEUR IDF - Admin',
  '7606795944',
  'admin123456',
  '👋 Bienvenue chez TIM LE MEILLEUR IDF ! Parcourez notre catalogue et commandez en quelques clics.',
  '#4CAF50',
  'fr',
  'https://t.me/Lejardinidf',
  'https://t.me/timlemeilleuridf_canal',
  '🔧 <b>Le bot est actuellement en maintenance.</b>\n\nNous revenons bientôt !\n\nContactez l''admin : @Lejardinidf',
  'https://t.me/Lejardinidf'
) ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- RLS: Désactiver RLS sur toutes les tables (mode service_role)
-- ============================================================
ALTER TABLE public.bot_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_state ENABLE ROW LEVEL SECURITY;

-- Policies: accès total via service_role (le bot utilise la clé service_role)
CREATE POLICY "service_role_all" ON public.bot_broadcasts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.bot_daily_stats FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.bot_orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.bot_products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.bot_referrals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.bot_reviews FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.bot_settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.bot_stats FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.bot_users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.bot_state FOR ALL USING (true) WITH CHECK (true);
