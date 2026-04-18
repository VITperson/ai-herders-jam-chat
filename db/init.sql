-- AI Herders Jam — full schema (single-shot, applied by postgres:16 on first start)
-- Mounted at /docker-entrypoint-initdb.d/01_init.sql (read-only).

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===========================================================================
-- USERS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS users (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext      NOT NULL,
    username      citext      NOT NULL,
    password_hash text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz
);

-- Email/username must be globally unique but we keep soft-delete rows around.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_active
    ON users (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_active
    ON users (username) WHERE deleted_at IS NULL;

-- ===========================================================================
-- PASSWORD RESETS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS password_resets (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      text        NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used       boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);

-- ===========================================================================
-- SESSIONS (managed by connect-pg-simple — exact shape from its README)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS user_sessions (
    sid    varchar      NOT NULL COLLATE "default",
    sess   json         NOT NULL,
    expire timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

ALTER TABLE user_sessions
    DROP CONSTRAINT IF EXISTS user_sessions_pkey;
ALTER TABLE user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);

-- Extra metadata about each session (User-Agent, IP, last seen). We keep it
-- separate so connect-pg-simple does not trip over unknown columns.
CREATE TABLE IF NOT EXISTS user_session_meta (
    sid          varchar     PRIMARY KEY REFERENCES user_sessions(sid) ON DELETE CASCADE,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent   text,
    ip           text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_session_meta_user_idx ON user_session_meta(user_id);

-- ===========================================================================
-- FRIENDSHIPS (hard-delete; normalized so user_a < user_b)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS friendships (
    user_a       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       text        NOT NULL CHECK (status IN ('pending', 'accepted')),
    requested_by uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS friendships_user_b_idx ON friendships(user_b);

-- ===========================================================================
-- USER BANS (block-list, hard-delete)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS user_bans (
    blocker    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker, blocked),
    CHECK (blocker <> blocked)
);
CREATE INDEX IF NOT EXISTS user_bans_blocked_idx ON user_bans(blocked);

-- ===========================================================================
-- ROOMS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS rooms (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        citext      NOT NULL,
    type        text        NOT NULL CHECK (type IN ('public', 'private', 'dm')),
    description text,
    owner_id    uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_name_unique_active
    ON rooms (name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS rooms_owner_idx ON rooms(owner_id);

-- ===========================================================================
-- ROOM MEMBERS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS room_members (
    room_id              uuid        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id              uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role                 text        NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at            timestamptz NOT NULL DEFAULT now(),
    last_read_message_id bigint,
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members(user_id);

-- ===========================================================================
-- ROOM BANS
-- ===========================================================================
CREATE TABLE IF NOT EXISTS room_bans (
    room_id    uuid        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_bans_user_idx ON room_bans(user_id);

-- ===========================================================================
-- ROOM INVITES (tokens for private rooms)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS room_invites (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id    uuid        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    token      text        NOT NULL UNIQUE,
    created_by uuid        REFERENCES users(id) ON DELETE SET NULL,
    expires_at timestamptz,
    used_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_invites_room_idx ON room_invites(room_id);

-- ===========================================================================
-- ROOM INVITATIONS (pending direct invites to a specific user — owner/admin
-- sends them, invitee can accept or decline; accepting upgrades to room_members)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS room_invitations (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id    uuid        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    inviter_id uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_invitations_user_idx ON room_invitations(user_id);
CREATE INDEX IF NOT EXISTS room_invitations_room_idx ON room_invitations(room_id);

-- ===========================================================================
-- MESSAGES (soft-delete; author_id nullable after user soft-delete)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS messages (
    id          bigserial   PRIMARY KEY,
    room_id     uuid        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    author_id   uuid        REFERENCES users(id) ON DELETE SET NULL,
    body        text        NOT NULL,
    reply_to_id bigint      REFERENCES messages(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    edited_at   timestamptz,
    deleted_at  timestamptz
);
-- Critical index: cursor pagination "WHERE room_id=? AND id<? ORDER BY id DESC"
CREATE INDEX IF NOT EXISTS messages_room_id_desc_idx ON messages(room_id, id DESC);
CREATE INDEX IF NOT EXISTS messages_author_idx ON messages(author_id);

-- ===========================================================================
-- ATTACHMENTS (linked to a message once saved; preserved even if message is deleted)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS attachments (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id    bigint      REFERENCES messages(id) ON DELETE SET NULL,
    uploader_id   uuid        REFERENCES users(id) ON DELETE SET NULL,
    original_name text        NOT NULL,
    stored_name   text        NOT NULL,
    mime          text        NOT NULL,
    size_bytes    bigint      NOT NULL,
    is_image      boolean     NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id);
CREATE INDEX IF NOT EXISTS attachments_uploader_idx ON attachments(uploader_id);
