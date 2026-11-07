CREATE TABLE graph_changes (
  userId TEXT NOT NULL,
  requestKey TEXT NOT NULL,
  hash TEXT NOT NULL,
  attempt TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY (userId, requestKey)
) STRICT;
