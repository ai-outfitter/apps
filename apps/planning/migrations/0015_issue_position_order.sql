-- GraphQL issues pages ordered by position (orderBy POSITION_ASC or POSITION_DESC) read in index order, whatever their filter.
CREATE INDEX `planning_issues_position` ON `planning_issues` (`installationId`,`position`,`id`);
