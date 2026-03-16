-- Migration pour les diffusions temporelles et badges
ALTER TABLE bot_broadcasts ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE bot_broadcasts ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;
ALTER TABLE bot_broadcasts ADD COLUMN IF NOT EXISTS badge TEXT;
