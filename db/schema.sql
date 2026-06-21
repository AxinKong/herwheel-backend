-- Run this once against your Postgres database to set up tables.

CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'learner', -- 'learner' | 'coach' | 'admin'
  lang            TEXT NOT NULL DEFAULT 'en',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE coach_profiles (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            JSONB NOT NULL,        -- {en, zh, ja}
  bio             JSONB NOT NULL,        -- {en, zh, ja}
  region_key      TEXT NOT NULL,
  rate            INTEGER NOT NULL,      -- JPY per hour
  cartype         TEXT[] NOT NULL,       -- ['auto','manual','ev']
  specialty       TEXT[] NOT NULL,       -- ['highway','parking',...]
  contact_email   TEXT NOT NULL,
  rating          NUMERIC(2,1) DEFAULT 5.0,
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  stripe_account_id TEXT,                -- Stripe Connect Express account id
  stripe_onboarded  BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE licence_documents (
  id              SERIAL PRIMARY KEY,
  coach_id        INTEGER NOT NULL REFERENCES coach_profiles(id) ON DELETE CASCADE,
  s3_key          TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  original_name   TEXT,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_status   TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  reviewed_by     INTEGER REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ
);

CREATE TABLE bookings (
  id                    SERIAL PRIMARY KEY,
  learner_id            INTEGER REFERENCES users(id),
  coach_id              INTEGER NOT NULL REFERENCES coach_profiles(id),
  amount_jpy            INTEGER NOT NULL,        -- total amount learner pays, in yen
  platform_fee_jpy      INTEGER NOT NULL,        -- 15% cut, in yen
  stripe_payment_intent_id TEXT UNIQUE,
  status                TEXT NOT NULL DEFAULT 'created', -- 'created' | 'paid' | 'failed' | 'refunded'
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at               TIMESTAMPTZ
);

CREATE INDEX idx_coach_profiles_status ON coach_profiles(status);
CREATE INDEX idx_coach_profiles_region ON coach_profiles(region_key);
CREATE INDEX idx_bookings_coach ON bookings(coach_id);
