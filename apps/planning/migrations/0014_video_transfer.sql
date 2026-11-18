CREATE TABLE planning_video_transfers (installationId TEXT NOT NULL, productionId TEXT NOT NULL, targetInstallationId TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(installationId,productionId));
--> statement-breakpoint
CREATE TABLE planning_video_imports (installationId TEXT NOT NULL, productionId TEXT NOT NULL, sourceInstallationId TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(installationId,productionId));
--> statement-breakpoint
CREATE TRIGGER video_transfer_production_update BEFORE UPDATE ON planning_video_productions WHEN EXISTS(SELECT 1 FROM planning_video_transfers WHERE installationId=OLD.installationId AND productionId=OLD.id) BEGIN SELECT RAISE(ABORT,'Production sealed for transfer'); END;
--> statement-breakpoint
CREATE TRIGGER video_transfer_take_update BEFORE UPDATE ON planning_video_takes WHEN EXISTS(SELECT 1 FROM planning_video_transfers WHERE installationId=OLD.installationId AND productionId=OLD.productionId) BEGIN SELECT RAISE(ABORT,'Production sealed for transfer'); END;
--> statement-breakpoint
CREATE TRIGGER video_transfer_take_insert BEFORE INSERT ON planning_video_takes WHEN EXISTS(SELECT 1 FROM planning_video_transfers WHERE installationId=NEW.installationId AND productionId=NEW.productionId) BEGIN SELECT RAISE(ABORT,'Production sealed for transfer'); END;
--> statement-breakpoint
CREATE TRIGGER video_transfer_asset_update BEFORE UPDATE ON planning_video_assets WHEN EXISTS(SELECT 1 FROM planning_video_transfers WHERE installationId=OLD.installationId AND productionId=OLD.productionId) BEGIN SELECT RAISE(ABORT,'Production sealed for transfer'); END;
--> statement-breakpoint
CREATE TRIGGER video_transfer_asset_insert BEFORE INSERT ON planning_video_assets WHEN EXISTS(SELECT 1 FROM planning_video_transfers WHERE installationId=NEW.installationId AND productionId=NEW.productionId) BEGIN SELECT RAISE(ABORT,'Production sealed for transfer'); END;
