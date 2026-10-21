-- Typed tables for the three entities the MCP server filters on. Each row keeps the full
-- entity as JSON in `data` (the shape the UI already uses); the other columns are derived
-- from it on every write so they can be indexed and queried.

CREATE TABLE projects (
  id       TEXT PRIMARY KEY,
  key      TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  seq      INTEGER NOT NULL DEFAULT 0, -- last issue number handed out; only ever grows
  updated  INTEGER NOT NULL,
  data     TEXT NOT NULL
);

CREATE TABLE tasks (
  id       TEXT PRIMARY KEY,
  key      TEXT NOT NULL UNIQUE,
  project  TEXT NOT NULL,
  status   TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee TEXT,
  due      TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  updated  INTEGER NOT NULL,
  data     TEXT NOT NULL
);
CREATE INDEX tasks_project_status ON tasks (project, status);
CREATE INDEX tasks_due ON tasks (due) WHERE due IS NOT NULL;
CREATE INDEX tasks_updated ON tasks (updated);

CREATE TABLE comments (
  id   TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  at   INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX comments_task ON comments (task, at);

-- Every other collection the UI keeps (activity, notifications, files, events, teams, ...).
CREATE TABLE records (
  kind TEXT NOT NULL,
  id   TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);

-- Singletons: workspace, preferences, project order, the signed-in member id, ...
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
