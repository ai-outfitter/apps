# Atomically create generated drafts through the existing mutation

SaveGeneratedDocument accepts either slug/title for creation or id/revision for an update. Creation commits the head, generated revision and page together; validation or a duplicate slug leaves no shell. Existing updates retain optimistic revision checks, authored title/body and published history. Editor authority remains required.
