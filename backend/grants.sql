-- The account the app logs in as. Already applied; the password lives in
-- DATABASE_URL and is not repeated here.
--
--   mysql --host prombot-prombot.a.aivencloud.com --port 14180 \
--         --user avnadmin --password defaultdb < backend/grants.sql
--
-- avnadmin is Aiven's superuser and the backend must never use it: a leaked
-- backend env would otherwise be a leaked database.
CREATE USER IF NOT EXISTS 'prombot'@'%' IDENTIFIED BY 'CHANGE_ME' REQUIRE SSL;

-- Rows in one table, nothing else. No DDL, and no reach into the older
-- `Presets` table the previous app owns.
GRANT SELECT, INSERT, UPDATE, DELETE ON defaultdb.user_presets TO 'prombot'@'%';
FLUSH PRIVILEGES;
