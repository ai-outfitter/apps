DROP TRIGGER workshop_archive_assembly;
--> statement-breakpoint
CREATE TRIGGER workshop_archive_assembly BEFORE UPDATE OF revision ON workshop_projects
WHEN NEW.revision <> OLD.revision BEGIN
  INSERT INTO workshop_assembly_revisions(projectId,revision,data)
  VALUES (OLD.id,OLD.revision, CASE WHEN OLD.name=NEW.name
    AND json_extract(OLD.data,'$.assembly') IS json_extract(NEW.data,'$.assembly')
    AND json_extract(OLD.data,'$.workspace.currentBuildId') IS json_extract(NEW.data,'$.workspace.currentBuildId')
    THEN 'null' ELSE json_object('name',OLD.name,'assembly',json_extract(OLD.data,'$.assembly'),
    'meshBuild',json((SELECT json_object('base',json_extract(r.value,'$.result.artifactBase'),
      'artifacts',json_extract(r.value,'$.result.manifest.artifacts')) FROM json_each(OLD.data,'$.workspace.requests') r
      WHERE json_extract(r.value,'$.id')=json_extract(OLD.data,'$.workspace.currentBuildId') LIMIT 1))) END);
END;
