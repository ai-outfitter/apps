CREATE TABLE forerunner_item_completions (
  id TEXT PRIMARY KEY NOT NULL,
  installationId TEXT NOT NULL,
  ownerId TEXT NOT NULL,
  itemId TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  revision INTEGER NOT NULL,
  completedAt INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX forerunner_completions_owner_date ON forerunner_item_completions (installationId, ownerId, completedAt);
--> statement-breakpoint
CREATE TRIGGER forerunner_completion_insert AFTER INSERT ON forerunner_items
WHEN NEW.status = 'done'
BEGIN
  INSERT INTO forerunner_item_completions VALUES (NEW.id || ':' || NEW.revision, NEW.installationId, NEW.ownerId, NEW.id, NEW.title, NEW.category, NEW.revision, NEW.updatedAt);
END;
--> statement-breakpoint
CREATE TRIGGER forerunner_completion_update AFTER UPDATE OF status ON forerunner_items
WHEN NEW.status = 'done' AND OLD.status != 'done'
BEGIN
  INSERT INTO forerunner_item_completions VALUES (NEW.id || ':' || NEW.revision, NEW.installationId, NEW.ownerId, NEW.id, NEW.title, NEW.category, NEW.revision, NEW.updatedAt);
END;
