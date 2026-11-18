CREATE TABLE workshop_assembly_revisions (
  projectId TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (projectId, revision)
) STRICT;
--> statement-breakpoint
CREATE TRIGGER workshop_archive_assembly BEFORE UPDATE OF revision ON workshop_projects
WHEN NEW.revision <> OLD.revision BEGIN
  INSERT INTO workshop_assembly_revisions(projectId,revision,data)
  VALUES (OLD.id,OLD.revision,json_object('name',OLD.name,'assembly',json_extract(OLD.data,'$.assembly'),'workspace',json_extract(OLD.data,'$.workspace')));
END;
--> statement-breakpoint
CREATE TRIGGER workshop_remove_assembly_history AFTER DELETE ON workshop_projects BEGIN
  DELETE FROM workshop_assembly_revisions WHERE projectId=OLD.id;
END;
