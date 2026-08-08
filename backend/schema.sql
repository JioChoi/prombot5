-- MySQL (Aiven). Already applied to defaultdb — kept so the table can be
-- rebuilt, and so its shape is reviewable without a database to hand.
--
--   mysql --host prombot-prombot.a.aivencloud.com --port 14180 \
--         --user avnadmin --password defaultdb < backend/schema.sql
--
-- user_presets, not "presets": MySQL folds table names to lower case on some
-- platforms and not others, so a name differing from the older `Presets` table
-- by case only is a name that collides the day the server moves. That table
-- belongs to the previous app and is deliberately left alone.
CREATE TABLE IF NOT EXISTS user_presets (
    -- sha256 of the NovelAI token, hex. The token itself never reaches the DB.
    user_id    CHAR(64)     NOT NULL,
    name       VARCHAR(100) NOT NULL,
    config     MEDIUMTEXT   NOT NULL,
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
