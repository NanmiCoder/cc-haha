/**
 * Companion reference files for the "supabase-best-practices" catalog skill,
 * written into references/ on install to make it a complete, self-contained
 * skill.
 *
 * Content adapted verbatim from the MIT-licensed openai/plugins repository
 * (https://github.com/openai/plugins), plugins/build-web-apps. Authoring-only
 * meta files (_template.md, _contributing.md) are intentionally omitted.
 */

export const SUPABASE_REFERENCE_FILES: Record<string, string> = {
  'references/_sections.md': `# Section Definitions

This file defines the rule categories for Postgres best practices. Rules are automatically assigned to sections based on their filename prefix.

## 1. Query Performance (query)
**Impact:** CRITICAL — Slow queries, missing indexes, inefficient query plans.

## 2. Connection Management (conn)
**Impact:** CRITICAL — Connection pooling, limits, and serverless strategies.

## 3. Security & RLS (security)
**Impact:** CRITICAL — Row-Level Security policies, privilege management, authentication.

## 4. Schema Design (schema)
**Impact:** HIGH — Table design, index strategies, partitioning, data type selection.

## 5. Concurrency & Locking (lock)
**Impact:** MEDIUM-HIGH — Transaction management, deadlock prevention, lock contention.

## 6. Data Access Patterns (data)
**Impact:** MEDIUM — N+1 elimination, batch operations, cursor-based pagination.

## 7. Monitoring & Diagnostics (monitor)
**Impact:** LOW-MEDIUM — pg_stat_statements, EXPLAIN ANALYZE, performance diagnostics.

## 8. Advanced Features (advanced)
**Impact:** LOW — Full-text search, JSONB optimization, extensions.
`,
  'references/query-missing-indexes.md': `## Add Indexes on WHERE and JOIN Columns

Queries filtering or joining on unindexed columns cause full table scans, which become exponentially slower as tables grow.

**Incorrect (sequential scan on large table):**

\`\`\`sql
-- No index on customer_id causes full table scan
select * from orders where customer_id = 123;
-- EXPLAIN shows: Seq Scan on orders
\`\`\`

**Correct (index scan):**

\`\`\`sql
create index orders_customer_id_idx on orders (customer_id);
select * from orders where customer_id = 123;
-- EXPLAIN shows: Index Scan using orders_customer_id_idx
\`\`\`

For JOIN columns, always index the foreign key side:

\`\`\`sql
create index orders_customer_id_idx on orders (customer_id);
select c.name, o.total from customers c join orders o on o.customer_id = c.id;
\`\`\`

Reference: https://supabase.com/docs/guides/database/query-optimization
`,
  'references/query-composite-indexes.md': `## Create Composite Indexes for Multi-Column Queries

When queries filter on multiple columns, a composite index is more efficient than separate single-column indexes.

**Correct (composite index):**

\`\`\`sql
-- Single composite index (leftmost column first for equality checks)
create index orders_status_created_idx on orders (status, created_at);
select * from orders where status = 'pending' and created_at > '2024-01-01';
\`\`\`

**Column order matters** — place equality columns first, range columns last. The leftmost-prefix rule means an index on (status, created_at) does not help a query filtering only on created_at.

Reference: https://www.postgresql.org/docs/current/indexes-multicolumn.html
`,
  'references/query-covering-indexes.md': `## Use Covering Indexes to Avoid Table Lookups

Covering indexes include all columns needed by a query, enabling index-only scans that skip the table entirely.

\`\`\`sql
-- Include non-searchable columns in the index
create index users_email_idx on users (email) include (name, created_at);
-- All columns served from index, no table access needed
select email, name, created_at from users where email = 'user@example.com';
\`\`\`

Use INCLUDE for columns you SELECT but don't filter on.

Reference: https://www.postgresql.org/docs/current/indexes-index-only-scans.html
`,
  'references/query-index-types.md': `## Choose the Right Index Type for Your Data

Different index types excel at different query patterns. The default B-tree isn't always optimal.

\`\`\`sql
-- B-tree (default): =, <, >, BETWEEN, IN, IS NULL
create index users_created_idx on users (created_at);
-- GIN: arrays, JSONB, full-text search
create index posts_tags_idx on posts using gin (tags);
-- GiST: geometric data, range types, nearest-neighbor (KNN) queries
create index locations_idx on places using gist (location);
-- BRIN: large time-series tables (10-100x smaller)
create index events_time_idx on events using brin (created_at);
-- Hash: equality-only
create index sessions_token_idx on sessions using hash (token);
\`\`\`

Reference: https://www.postgresql.org/docs/current/indexes-types.html
`,
  'references/query-partial-indexes.md': `## Use Partial Indexes for Filtered Queries

Partial indexes only include rows matching a WHERE condition, making them smaller and faster when queries consistently filter on the same condition.

\`\`\`sql
-- Index only includes active users
create index users_active_email_idx on users (email) where deleted_at is null;
select * from users where email = 'user@example.com' and deleted_at is null;
\`\`\`

Reference: https://www.postgresql.org/docs/current/indexes-partial.html
`,
  'references/conn-pooling.md': `## Use Connection Pooling for All Applications

Postgres connections are expensive (1-3MB RAM each). Without pooling, applications exhaust connections under load. Use a pooler like PgBouncer between app and database; the application connects to the pooler, which reuses a small pool to Postgres.

Pool modes:
- **Transaction mode**: connection returned after each transaction (best for most apps).
- **Session mode**: connection held for entire session (needed for prepared statements, temp tables).

Configure pool_size based on (CPU cores * 2) + spindle_count.

Reference: https://supabase.com/docs/guides/database/connecting-to-postgres#connection-pooler
`,
  'references/conn-limits.md': `## Set Appropriate Connection Limits

Too many connections exhaust memory and degrade performance. Each connection uses 1-3MB RAM.

\`\`\`sql
-- Formula: max_connections ~= (RAM in MB / 5MB per connection) - reserved
-- Practically, 100-200 is better for query performance
alter system set max_connections = 100;
-- work_mem * max_connections should not exceed 25% of RAM
alter system set work_mem = '8MB';
\`\`\`

Monitor: \`select count(*), state from pg_stat_activity group by state;\`

Reference: https://supabase.com/docs/guides/platform/performance#connection-management
`,
  'references/conn-idle-timeout.md': `## Configure Idle Connection Timeouts

Idle connections waste resources. Configure timeouts to automatically reclaim them.

\`\`\`sql
-- Terminate connections idle in transaction after 30 seconds
alter system set idle_in_transaction_session_timeout = '30s';
-- Terminate completely idle connections after 10 minutes
alter system set idle_session_timeout = '10min';
select pg_reload_conf();
\`\`\`

For pooled connections, configure server_idle_timeout / client_idle_timeout at the pooler level.

Reference: https://www.postgresql.org/docs/current/runtime-config-client.html
`,
  'references/conn-prepared-statements.md': `## Use Prepared Statements Correctly with Pooling

Prepared statements are tied to individual database connections. In transaction-mode pooling, connections are shared, causing conflicts ("prepared statement does not exist").

Options:
- Use unnamed prepared statements (most ORMs do this automatically).
- Deallocate after use in transaction mode.
- Use session-mode pooling so prepared statements persist.

Many drivers use prepared statements by default — Node.js pg supports \`{ prepare: false }\`; JDBC supports \`prepareThreshold=0\`.

Reference: https://supabase.com/docs/guides/database/connecting-to-postgres#connection-pool-modes
`,
  'references/data-batch-inserts.md': `## Batch INSERT Statements for Bulk Data

Individual INSERT statements have high overhead. Batch multiple rows in single statements or use COPY.

\`\`\`sql
-- Multiple rows in single statement (up to ~1000 rows per batch)
insert into events (user_id, action) values (1, 'click'), (1, 'view'), (2, 'click');
\`\`\`

For large imports, COPY is fastest:

\`\`\`sql
copy events (user_id, action, created_at) from '/path/to/data.csv' with (format csv, header true);
\`\`\`

Reference: https://www.postgresql.org/docs/current/sql-copy.html
`,
  'references/data-n-plus-one.md': `## Eliminate N+1 Queries with Batch Loading

N+1 queries execute one query per item in a loop. Batch them into a single query using arrays or JOINs.

\`\`\`sql
-- Query once with ANY instead of one query per user
select * from orders where user_id = any(array[1, 2, 3]);
-- Or JOIN instead of loop
select u.id, u.name, o.* from users u left join orders o on o.user_id = u.id where u.active = true;
-- Array parameter from application
select * from orders where user_id = any($1::bigint[]);
\`\`\`

Reference: https://supabase.com/docs/guides/database/query-optimization
`,
  'references/data-pagination.md': `## Use Cursor-Based Pagination Instead of OFFSET

OFFSET-based pagination scans all skipped rows, getting slower on deeper pages. Cursor (keyset) pagination is O(1).

\`\`\`sql
-- Page 1
select * from products order by id limit 20;
-- Page 2: start after last id (uses index, always fast)
select * from products where id > 20 order by id limit 20;
\`\`\`

For multi-column sorting, the cursor must include all sort columns:

\`\`\`sql
select * from products where (created_at, id) > ('2024-01-15 10:00:00', 12345) order by created_at, id limit 20;
\`\`\`

Reference: https://supabase.com/docs/guides/database/pagination
`,
  'references/data-upsert.md': `## Use UPSERT for Insert-or-Update Operations

Separate SELECT-then-INSERT/UPDATE creates race conditions. Use INSERT ... ON CONFLICT for atomic upserts.

\`\`\`sql
insert into settings (user_id, key, value) values (123, 'theme', 'dark')
on conflict (user_id, key) do update set value = excluded.value, updated_at = now();
\`\`\`

Insert-or-ignore:

\`\`\`sql
insert into page_views (page_id, user_id) values (1, 123) on conflict (page_id, user_id) do nothing;
\`\`\`

Reference: https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT
`,
  'references/advanced-full-text-search.md': `## Use tsvector for Full-Text Search

LIKE with wildcards can't use indexes. Full-text search with tsvector is orders of magnitude faster.

\`\`\`sql
alter table articles add column search_vector tsvector
  generated always as (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))) stored;
create index articles_search_idx on articles using gin (search_vector);
select * from articles where search_vector @@ to_tsquery('english', 'postgresql & performance');
\`\`\`

Operators: \`&\` (AND), \`|\` (OR), \`:*\` (prefix). Use ts_rank for ranking.

Reference: https://supabase.com/docs/guides/database/full-text-search
`,
  'references/advanced-jsonb-indexing.md': `## Index JSONB Columns for Efficient Querying

JSONB queries without indexes scan the entire table. Use GIN indexes for containment queries.

\`\`\`sql
-- GIN index for containment operators (@>, ?, ?&, ?|)
create index products_attrs_gin on products using gin (attributes);
select * from products where attributes @> '{"color": "red"}';
-- For specific key lookups, use an expression index
create index products_brand_idx on products ((attributes->>'brand'));
\`\`\`

jsonb_path_ops supports only @> but produces a 2-3x smaller index.

Reference: https://www.postgresql.org/docs/current/datatype-json.html#JSON-INDEXING
`,
  'references/lock-advisory.md': `## Use Advisory Locks for Application-Level Locking

Advisory locks provide application-level coordination without requiring database rows to lock.

\`\`\`sql
-- Session-level advisory lock (released on disconnect or unlock)
select pg_advisory_lock(hashtext('report_generator'));
-- ... do exclusive work ...
select pg_advisory_unlock(hashtext('report_generator'));

-- Transaction-level lock (released on commit/rollback)
begin;
select pg_advisory_xact_lock(hashtext('daily_report'));
commit;

-- Non-blocking try-lock
select pg_try_advisory_lock(hashtext('resource_name'));
\`\`\`

Reference: https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
`,
  'references/lock-deadlock-prevention.md': `## Prevent Deadlocks with Consistent Lock Ordering

Deadlocks occur when transactions lock resources in different orders. Always acquire locks in a consistent order.

\`\`\`sql
-- Explicitly acquire locks in ID order before updating
begin;
select * from accounts where id in (1, 2) order by id for update;
update accounts set balance = balance - 100 where id = 1;
update accounts set balance = balance + 100 where id = 2;
commit;
\`\`\`

Alternative: update atomically in a single statement. Detect via \`select * from pg_stat_database where deadlocks > 0;\` and enable \`log_lock_waits\`.

Reference: https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-DEADLOCKS
`,
  'references/lock-short-transactions.md': `## Keep Transactions Short to Reduce Lock Contention

Long-running transactions hold locks that block other queries. Keep transactions as short as possible — validate data and call external APIs outside the transaction, then hold the lock only for the actual update.

\`\`\`sql
begin;
update orders set status = 'paid', payment_id = $1 where id = $2 and status = 'pending' returning *;
commit;
\`\`\`

Use \`statement_timeout\` to prevent runaway transactions.

Reference: https://www.postgresql.org/docs/current/tutorial-transactions.html
`,
  'references/lock-skip-locked.md': `## Use SKIP LOCKED for Non-Blocking Queue Processing

When multiple workers process a queue, SKIP LOCKED allows workers to process different rows without waiting.

\`\`\`sql
-- Atomic claim-and-update in one statement
update jobs
set status = 'processing', worker_id = $1, started_at = now()
where id = (
  select id from jobs where status = 'pending'
  order by created_at limit 1 for update skip locked
)
returning *;
\`\`\`

Reference: https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
`,
  'references/monitor-explain-analyze.md': `## Use EXPLAIN ANALYZE to Diagnose Slow Queries

EXPLAIN ANALYZE executes the query and shows actual timings, revealing the true performance bottlenecks.

\`\`\`sql
explain (analyze, buffers, format text)
select * from orders where customer_id = 123 and status = 'pending';
\`\`\`

Look for: Seq Scan on large tables (missing index), high "Rows Removed by Filter" (poor selectivity), \`read\` >> \`hit\` buffers (not cached), external merge sorts (work_mem too low).

Reference: https://supabase.com/docs/guides/database/inspect
`,
  'references/monitor-pg-stat-statements.md': `## Enable pg_stat_statements for Query Analysis

pg_stat_statements tracks execution statistics for all queries, helping identify slow and frequent queries.

\`\`\`sql
create extension if not exists pg_stat_statements;

-- Slowest queries by total time
select calls, round(total_exec_time::numeric, 2) as total_time_ms,
  round(mean_exec_time::numeric, 2) as mean_time_ms, query
from pg_stat_statements order by total_exec_time desc limit 10;

select pg_stat_statements_reset();
\`\`\`

Reference: https://supabase.com/docs/guides/database/extensions/pg_stat_statements
`,
  'references/monitor-vacuum-analyze.md': `## Maintain Table Statistics with VACUUM and ANALYZE

Outdated statistics cause the query planner to make poor decisions. VACUUM reclaims space, ANALYZE updates statistics.

\`\`\`sql
analyze orders;
-- Check when tables were last analyzed
select relname, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
from pg_stat_user_tables order by last_analyze nulls first;
-- Tune autovacuum for high-churn tables
alter table orders set (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);
\`\`\`

Reference: https://supabase.com/docs/guides/database/database-size#vacuum-operations
`,
  'references/schema-constraints.md': `## Add Constraints Safely in Migrations

PostgreSQL does not support \`ADD CONSTRAINT IF NOT EXISTS\`. Use a DO block to check before adding so migrations stay idempotent.

\`\`\`sql
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_birthchart_id_unique'
    and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
    add constraint profiles_birthchart_id_unique unique (birthchart_id);
  end if;
end $$;
\`\`\`

Inspect with \`select conname, contype, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.profiles'::regclass;\` (contype: p=PK, f=FK, u=UNIQUE, c=CHECK).

Reference: https://www.postgresql.org/docs/current/ddl-constraints.html
`,
  'references/schema-data-types.md': `## Choose Appropriate Data Types

Using the right data types reduces storage, improves query performance, and prevents bugs.

\`\`\`sql
create table users (
  id bigint generated always as identity primary key,  -- not int (overflow)
  email text,                     -- not varchar(n) unless constrained
  created_at timestamptz,         -- not timestamp (keep timezone)
  is_active boolean default true, -- not a string
  price numeric(10,2)             -- not float (exact decimals)
);
\`\`\`

Reference: https://www.postgresql.org/docs/current/datatype.html
`,
  'references/schema-foreign-key-indexes.md': `## Index Foreign Key Columns

Postgres does not automatically index foreign key columns. Missing indexes cause slow JOINs and CASCADE operations.

\`\`\`sql
create index orders_customer_id_idx on orders (customer_id);
\`\`\`

Find missing FK indexes:

\`\`\`sql
select conrelid::regclass as table_name, a.attname as fk_column
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
where c.contype = 'f'
  and not exists (
    select 1 from pg_index i where i.indrelid = c.conrelid and a.attnum = any(i.indkey)
  );
\`\`\`

Reference: https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK
`,
  'references/schema-lowercase-identifiers.md': `## Use Lowercase Identifiers for Compatibility

PostgreSQL folds unquoted identifiers to lowercase. Quoted mixed-case identifiers require quotes forever and cause issues with tools, ORMs, and AI assistants.

\`\`\`sql
-- Prefer unquoted lowercase snake_case
create table users (
  user_id bigint primary key,
  first_name text,
  last_name text
);
select first_name from users where user_id = 1;
\`\`\`

Configure ORMs to emit snake_case; if stuck with mixed-case, add a lowercase view as a compatibility layer.

Reference: https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS
`,
  'references/schema-partitioning.md': `## Partition Large Tables for Better Performance

Partitioning splits a large table into smaller pieces, improving query performance and maintenance.

\`\`\`sql
create table events (
  id bigint generated always as identity,
  created_at timestamptz not null,
  data jsonb
) partition by range (created_at);

create table events_2024_01 partition of events
  for values from ('2024-01-01') to ('2024-02-01');
-- Drop old data instantly
drop table events_2023_01;
\`\`\`

Partition when: tables > 100M rows, time-series with date-based queries, need to drop old data efficiently.

Reference: https://www.postgresql.org/docs/current/ddl-partitioning.html
`,
  'references/schema-primary-keys.md': `## Select Optimal Primary Key Strategy

Primary key choice affects insert performance, index size, and replication efficiency.

\`\`\`sql
-- Single database: bigint identity (sequential, 8 bytes, SQL-standard)
create table users (id bigint generated always as identity primary key);
-- Distributed/exposed IDs: UUIDv7 (time-ordered, no fragmentation)
create table orders (id uuid default uuid_generate_v7() primary key);
\`\`\`

Avoid random UUIDv4 as primary keys on large tables (index fragmentation). \`serial\` works but \`identity\` is preferred.

Reference: https://www.postgresql.org/docs/current/sql-createtable.html
`,
  'references/security-privileges.md': `## Apply Principle of Least Privilege

Grant only the minimum permissions required. Never use superuser for application queries.

\`\`\`sql
create role app_readonly nologin;
grant usage on schema public to app_readonly;
grant select on public.products, public.categories to app_readonly;

create role app_writer nologin;
grant usage on schema public to app_writer;
grant select, insert, update on public.orders to app_writer;
grant usage on sequence orders_id_seq to app_writer;

-- Revoke default public access
revoke all on schema public from public;
\`\`\`

Reference: https://supabase.com/blog/postgres-roles-and-privileges
`,
  'references/security-rls-basics.md': `## Enable Row Level Security for Multi-Tenant Data

Row Level Security (RLS) enforces data access at the database level, ensuring users only see their own data.

\`\`\`sql
alter table orders enable row level security;
create policy orders_user_policy on orders
  for all
  using (user_id = current_setting('app.current_user_id')::bigint);
-- Force RLS even for table owners
alter table orders force row level security;
\`\`\`

For authenticated roles, policies can use \`auth.uid()\`.

Reference: https://supabase.com/docs/guides/database/postgres/row-level-security
`,
  'references/security-rls-performance.md': `## Optimize RLS Policies for Performance

Poorly written RLS policies can cause severe performance issues. Wrap functions in a SELECT so they are evaluated once, not per row.

\`\`\`sql
-- Slow: auth.uid() called per row
create policy orders_policy on orders using (auth.uid() = user_id);
-- Fast: wrapped in select, cached
create policy orders_policy on orders using ((select auth.uid()) = user_id);
\`\`\`

Use security definer helper functions for complex checks, and always index columns used in RLS policies.

Reference: https://supabase.com/docs/guides/database/postgres/row-level-security#rls-performance-recommendations
`,
}
