import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Fault } from './errors.js';

export class Store {
  constructor(directory) {
    this.db = new DatabaseSync(join(directory, 'state.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Fault('UNSUPPORTED', 'This daemon is older than the state database. Upgrade it first.');
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, started TEXT NOT NULL, body TEXT NOT NULL) STRICT;
      PRAGMA user_version=1;
      COMMIT;`);
  }

  projects() { return this.db.prepare('SELECT body FROM projects ORDER BY id').all().map(row => JSON.parse(row.body)); }
  project(id) {
    const row = this.db.prepare('SELECT body FROM projects WHERE id = ?').get(id);
    if (!row) throw new Fault('NOT_FOUND', 'Unknown project ID. Run list or discover first.');
    return JSON.parse(row.body);
  }
  save(project) {
    this.db.prepare('INSERT OR REPLACE INTO projects VALUES (?, ?)').run(project.id, JSON.stringify(project));
  }
  journal(operation) {
    this.db.prepare('INSERT OR REPLACE INTO operations VALUES (?, ?, ?)')
      .run(operation.id, operation.started, JSON.stringify(operation));
  }
  history(limit = 100) {
    return this.db.prepare('SELECT body FROM operations ORDER BY started DESC LIMIT ?')
      .all(limit).map(row => JSON.parse(row.body));
  }
  operation(id) {
    const row = this.db.prepare('SELECT body FROM operations WHERE id = ?').get(id);
    if (!row) throw new Fault('NOT_FOUND', 'Unknown operation ID.');
    return JSON.parse(row.body);
  }
  recover() {
    const rows = this.db.prepare("SELECT body FROM operations WHERE json_extract(body, '$.status') = 'running'").all();
    for (const row of rows) {
      const op = JSON.parse(row.body);
      op.status = 'interrupted';
      op.ended = new Date().toISOString();
      this.journal(op);
    }
  }
  commit(project, operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (project) this.save(project);
      this.journal(operation);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.db.close(); }
}
