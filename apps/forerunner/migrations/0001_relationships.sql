-- Relationships are checked in SQLite as well as in the API so concurrent
-- parent updates/deletes cannot bypass member and installation isolation.
CREATE TRIGGER forerunner_parent_insert BEFORE INSERT ON forerunner_items
WHEN (NEW.category = 'stone' AND NEW.parentId IS NOT NULL)
 OR (NEW.category = 'pebble' AND NEW.parentId IS NULL)
 OR (NEW.parentId IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM forerunner_items p WHERE p.id = NEW.parentId
   AND p.category = 'stone' AND p.ownerId = NEW.ownerId
   AND p.installationId = NEW.installationId AND p.id != NEW.id
 ))
BEGIN SELECT RAISE(ABORT, 'forerunner_parent'); END;
--> statement-breakpoint
CREATE TRIGGER forerunner_parent_update BEFORE UPDATE ON forerunner_items
WHEN (NEW.category = 'stone' AND NEW.parentId IS NOT NULL)
 OR (NEW.category = 'pebble' AND NEW.parentId IS NULL)
 OR (NEW.parentId IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM forerunner_items p WHERE p.id = NEW.parentId
   AND p.category = 'stone' AND p.ownerId = NEW.ownerId
   AND p.installationId = NEW.installationId AND p.id != NEW.id
 ))
BEGIN SELECT RAISE(ABORT, 'forerunner_parent'); END;
--> statement-breakpoint
CREATE TRIGGER forerunner_children_update BEFORE UPDATE ON forerunner_items
WHEN (NEW.category != 'stone' OR NEW.ownerId != OLD.ownerId OR NEW.installationId != OLD.installationId)
 AND EXISTS (SELECT 1 FROM forerunner_items WHERE parentId = OLD.id)
BEGIN SELECT RAISE(ABORT, 'forerunner_children'); END;
--> statement-breakpoint
CREATE TRIGGER forerunner_children_delete BEFORE DELETE ON forerunner_items
WHEN EXISTS (SELECT 1 FROM forerunner_items WHERE parentId = OLD.id)
BEGIN SELECT RAISE(ABORT, 'forerunner_children'); END;
--> statement-breakpoint
CREATE TRIGGER forerunner_limit BEFORE INSERT ON forerunner_items
WHEN (SELECT count(*) FROM forerunner_items WHERE ownerId = NEW.ownerId AND installationId = NEW.installationId) >= 500
BEGIN SELECT RAISE(ABORT, 'forerunner_limit'); END;
