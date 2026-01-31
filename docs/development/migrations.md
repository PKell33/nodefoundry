# Database Migrations

This document describes how to work with database migrations in the Ownprem orchestrator.

## Overview

The orchestrator uses SQLite with a custom migration system. Migrations are:
- **Version-tracked** via the `schema_migrations` table
- **Idempotent** - safe to run multiple times
- **Sequential** - applied in order by version number
- **Forward-only** - no automatic rollback support

## Migration Tracking

Applied migrations are recorded in the `schema_migrations` table:

```sql
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

On startup, the orchestrator:
1. Creates the `schema_migrations` table if it doesn't exist
2. Checks which migrations have been applied
3. Runs any unapplied migrations in order
4. Records each successful migration

## Adding a New Migration

### 1. Choose the Next Version Number

Look at the existing migrations in `apps/orchestrator/src/db/index.ts` and use the next sequential number.

### 2. Add the Migration Code

Add your migration to the `runMigrations()` function:

```typescript
// Migration N: Description of what this migration does
if (!isMigrationApplied(database, N)) {
  // Check if migration is needed (for existing databases)
  const columns = database.prepare("PRAGMA table_info(table_name)").all();
  const hasColumn = columns.some(col => col.name === 'new_column');

  if (!hasColumn) {
    database.exec('ALTER TABLE table_name ADD COLUMN new_column TYPE DEFAULT value');
  }

  recordMigration(database, N, 'descriptive_migration_name');
  dbLogger.info('Migration N: Description of changes');
}
```

### 3. Update schema.sql (for New Installations)

If your migration adds columns, tables, or indexes, also update `apps/orchestrator/src/db/schema.sql` so new installations have the correct schema from the start.

## Migration Patterns

### Adding a Column

```typescript
if (!isMigrationApplied(database, 9)) {
  const columns = database.prepare("PRAGMA table_info(users)").all();
  const hasColumn = columns.some(col => col.name === 'email');
  if (!hasColumn) {
    database.exec('ALTER TABLE users ADD COLUMN email TEXT');
  }
  recordMigration(database, 9, 'add_email_to_users');
}
```

### Adding an Index

```typescript
if (!isMigrationApplied(database, 10)) {
  database.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  recordMigration(database, 10, 'add_users_email_index');
}
```

### Recreating a Table (for FK changes)

SQLite doesn't support `ALTER TABLE` to add/modify foreign keys. You must recreate the table:

```typescript
if (!isMigrationApplied(database, 11)) {
  // Check if migration needed
  const schema = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='services'
  `).get();

  if (schema && !schema.sql.includes('ON DELETE CASCADE')) {
    // 1. Create new table with correct constraints
    database.exec(`
      CREATE TABLE services_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE
      )
    `);

    // 2. Copy data (filtering out orphaned rows)
    database.exec(`
      INSERT INTO services_new (id, name, server_id)
      SELECT id, name, server_id FROM services
      WHERE server_id IN (SELECT id FROM servers)
    `);

    // 3. Drop old table and rename
    database.exec('DROP TABLE services');
    database.exec('ALTER TABLE services_new RENAME TO services');

    // 4. Recreate indexes
    database.exec('CREATE INDEX IF NOT EXISTS idx_services_server ON services(server_id)');
  }

  recordMigration(database, 11, 'add_cascade_to_services');
}
```

### Data Migration

```typescript
if (!isMigrationApplied(database, 12)) {
  // Add column first
  database.exec('ALTER TABLE tokens ADD COLUMN family_id TEXT');

  // Migrate existing data
  database.exec('UPDATE tokens SET family_id = id WHERE family_id IS NULL');

  recordMigration(database, 12, 'add_token_families');
}
```

## Naming Conventions

Migration names should be:
- **Lowercase with underscores**: `add_email_to_users`, `remove_legacy_column`
- **Descriptive**: Indicate what changes and where
- **Action-oriented**: Start with verb (`add`, `remove`, `update`, `create`)

Examples:
- `add_rotated_at_to_secrets`
- `create_backup_codes_table`
- `add_fk_cascade_to_services`
- `migrate_token_families`

## Testing Migrations

### Local Testing

1. **Test on fresh database**: Delete `./data/ownprem.sqlite` and restart
2. **Test on existing database**: Run with existing data to verify migration logic

### Verify Migration Applied

Check the `schema_migrations` table:

```bash
sqlite3 ./data/ownprem.sqlite "SELECT * FROM schema_migrations ORDER BY version"
```

### Manual Testing Steps

```bash
# 1. Backup existing database
cp ./data/ownprem.sqlite ./data/ownprem.sqlite.backup

# 2. Start the orchestrator (migrations run automatically)
npm run dev

# 3. Verify schema_migrations shows new migration
sqlite3 ./data/ownprem.sqlite "SELECT * FROM schema_migrations"

# 4. Verify the actual schema change
sqlite3 ./data/ownprem.sqlite ".schema table_name"
```

## Rollback Considerations

The migration system is forward-only. To "rollback":

1. **Manual reversal**: Write SQL to undo the change
2. **Restore from backup**: Replace database with pre-migration backup
3. **Code the reversal**: Add a new migration that undoes the previous one

For production, always:
- Take a database backup before deploying
- Test migrations on a copy of production data first
- Have a manual rollback plan documented

## Best Practices

1. **Keep migrations small**: One logical change per migration
2. **Always check if needed**: Use PRAGMA or SELECT to avoid re-applying
3. **Handle data carefully**: Filter orphaned rows when recreating tables
4. **Update schema.sql**: Keep it in sync for new installations
5. **Log clearly**: Use descriptive log messages
6. **Test both paths**: Fresh install and upgrade from previous version

## Troubleshooting

### Migration Stuck

If a migration partially fails:
1. Check `schema_migrations` for what was recorded
2. Check the actual schema with `.schema table_name`
3. Manually complete the migration or revert

### Column Already Exists

This is normal - migrations are idempotent. The check `hasColumn` prevents errors.

### Foreign Key Violations

When recreating tables, filter out orphaned data:
```sql
WHERE foreign_key_column IN (SELECT id FROM parent_table)
```
