BEGIN;

CREATE TABLE IF NOT EXISTS employees (
  id BIGSERIAL PRIMARY KEY,
  notion_id TEXT UNIQUE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  code TEXT,
  role TEXT NOT NULL DEFAULT '',
  hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL DEFAULT 'notion',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_report_id TEXT
);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS code_hash TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS code_lookup TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS employees_code_unique
ON employees (code)
WHERE code IS NOT NULL AND code <> '';

CREATE UNIQUE INDEX IF NOT EXISTS employees_code_lookup_unique
ON employees (code_lookup)
WHERE code_lookup IS NOT NULL AND code_lookup <> '';

CREATE INDEX IF NOT EXISTS employees_normalized_name_idx
ON employees (normalized_name);

CREATE INDEX IF NOT EXISTS employees_active_idx
ON employees (active);

CREATE TABLE IF NOT EXISTS rooms (
  id BIGSERIAL PRIMARY KEY,
  notion_id TEXT UNIQUE,
  work_date DATE NOT NULL,
  room_number TEXT NOT NULL,
  normalized_room TEXT NOT NULL,
  room_type TEXT NOT NULL DEFAULT '',
  building TEXT NOT NULL DEFAULT 'OTHER',
  cleaning_status TEXT NOT NULL DEFAULT '',
  guest_out BOOLEAN NOT NULL DEFAULT FALSE,
  guest_out_at TIMESTAMPTZ,
  urgent BOOLEAN NOT NULL DEFAULT FALSE,
  arrival BOOLEAN NOT NULL DEFAULT FALSE,
  stayover BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_cleaner TEXT NOT NULL DEFAULT '',
  assigned_cleaners JSONB NOT NULL DEFAULT '[]'::jsonb,
  assigned_inspector TEXT NOT NULL DEFAULT '',
  assigned_inspectors JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  inspection_started_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'notion',
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_date, normalized_room)
);

CREATE INDEX IF NOT EXISTS rooms_work_date_idx
ON rooms (work_date);

CREATE INDEX IF NOT EXISTS rooms_status_idx
ON rooms (work_date, cleaning_status);

CREATE INDEX IF NOT EXISTS rooms_guest_out_idx
ON rooms (work_date, guest_out);

CREATE INDEX IF NOT EXISTS rooms_urgent_idx
ON rooms (work_date, urgent);

-- 417 Operations Core v1: estado canónico independiente del nombre legado de Notion.
ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS core_status TEXT NOT NULL DEFAULT 'PENDING';

ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS stayover BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS rooms_stayover_idx
ON rooms (work_date, stayover);

CREATE INDEX IF NOT EXISTS rooms_core_status_idx
ON rooms (work_date, core_status);

CREATE INDEX IF NOT EXISTS rooms_cleaner_date_idx
ON rooms (work_date, assigned_cleaner);

CREATE INDEX IF NOT EXISTS rooms_inspector_date_idx
ON rooms (work_date, assigned_inspector);

CREATE INDEX IF NOT EXISTS rooms_updated_at_idx
ON rooms (work_date, updated_at DESC);

CREATE TABLE IF NOT EXISTS assignments (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT REFERENCES rooms(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  unit TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  normalized_employee TEXT NOT NULL,
  assignment_role TEXT NOT NULL,
  split_percent NUMERIC(7,4) NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS assignments_employee_date_idx
ON assignments (normalized_employee, work_date);

CREATE INDEX IF NOT EXISTS assignments_room_idx
ON assignments (room_id);

CREATE TABLE IF NOT EXISTS operations_logs (
  id BIGSERIAL PRIMARY KEY,
  notion_id TEXT UNIQUE,
  external_event_id TEXT,
  work_date DATE NOT NULL,
  event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unit TEXT NOT NULL DEFAULT '',
  normalized_room TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  cleaner TEXT NOT NULL DEFAULT '',
  inspector TEXT NOT NULL DEFAULT '',
  employee TEXT NOT NULL DEFAULT '',
  role_worked TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other',
  priority TEXT NOT NULL DEFAULT 'Normal',
  source TEXT NOT NULL DEFAULT '417-maid',
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS operations_logs_external_event_unique
ON operations_logs (external_event_id)
WHERE external_event_id IS NOT NULL AND external_event_id <> '';

CREATE INDEX IF NOT EXISTS operations_logs_date_idx
ON operations_logs (work_date, event_time DESC);

CREATE INDEX IF NOT EXISTS operations_logs_unit_idx
ON operations_logs (work_date, normalized_room);

CREATE INDEX IF NOT EXISTS operations_logs_employee_idx
ON operations_logs (work_date, employee);

CREATE TABLE IF NOT EXISTS payroll_records (
  id BIGSERIAL PRIMARY KEY,
  notion_id TEXT UNIQUE,
  work_date DATE NOT NULL,
  employee TEXT NOT NULL,
  normalized_employee TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  room_type TEXT NOT NULL DEFAULT '',
  gross_unit_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  split_count INTEGER NOT NULL DEFAULT 1 CHECK (split_count > 0),
  split_percent NUMERIC(7,4) NOT NULL DEFAULT 1,
  amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  pay_type TEXT NOT NULL DEFAULT 'unit',
  role_worked TEXT NOT NULL DEFAULT 'Cleaner',
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  source TEXT NOT NULL DEFAULT 'notion',
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migración: permite registros legítimos repetidos en la misma unidad.
-- La identidad de cada pago sincronizado es notion_id.
-- Eliminamos los nombres históricos conocidos y cualquier variante antigua
-- que PostgreSQL haya conservado de versiones anteriores del esquema.
ALTER TABLE payroll_records
DROP CONSTRAINT IF EXISTS payroll_records_work_date_normalized_employee_unit_pay_type_key;

ALTER TABLE payroll_records
DROP CONSTRAINT IF EXISTS payroll_records_work_date_normalized_employee_unit_pay_type_role_worked_key;

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'payroll_records'::regclass
      AND contype = 'u'
      AND conname LIKE 'payroll_records_work_date_normalized_employee_unit_pay_type%'
  LOOP
    EXECUTE format(
      'ALTER TABLE payroll_records DROP CONSTRAINT IF EXISTS %I',
      constraint_record.conname
    );
  END LOOP;
END $$;

DROP INDEX IF EXISTS payroll_records_work_date_normalized_employee_unit_pay_type_key;
DROP INDEX IF EXISTS payroll_records_work_date_normalized_employee_unit_pay_type_role_worked_key;

CREATE UNIQUE INDEX IF NOT EXISTS payroll_records_notion_id_unique_idx
ON payroll_records (notion_id)
WHERE notion_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payroll_records_week_idx
ON payroll_records (week_start, week_end);

CREATE INDEX IF NOT EXISTS payroll_records_employee_idx
ON payroll_records (normalized_employee, work_date);

CREATE TABLE IF NOT EXISTS time_clock_records (
  id BIGSERIAL PRIMARY KEY,
  notion_id TEXT UNIQUE,
  employee TEXT NOT NULL,
  normalized_employee TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  role_worked TEXT NOT NULL DEFAULT '',
  work_location TEXT NOT NULL DEFAULT 'Unspecified',
  location_note TEXT NOT NULL DEFAULT '',
  clock_in TIMESTAMPTZ NOT NULL,
  clock_out TIMESTAMPTZ,
  break_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
  hours NUMERIC(8,2) NOT NULL DEFAULT 0,
  hourly_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  total NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Open',
  source TEXT NOT NULL DEFAULT 'notion',
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


ALTER TABLE time_clock_records ADD COLUMN IF NOT EXISTS work_location TEXT NOT NULL DEFAULT 'Unspecified';
ALTER TABLE time_clock_records ADD COLUMN IF NOT EXISTS location_note TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS time_clock_location_idx ON time_clock_records (work_location, clock_in);

CREATE INDEX IF NOT EXISTS time_clock_employee_idx
ON time_clock_records (normalized_employee, clock_in);

CREATE INDEX IF NOT EXISTS time_clock_status_idx
ON time_clock_records (status);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  employee TEXT NOT NULL DEFAULT '',
  normalized_employee TEXT NOT NULL DEFAULT '',
  notification_type TEXT NOT NULL DEFAULT 'GENERAL',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'Normal',
  read_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT '417-maid',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_employee_idx
ON notifications (normalized_employee, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_unread_idx
ON notifications (normalized_employee, read_at)
WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS sync_status (
  id BIGSERIAL PRIMARY KEY,
  sync_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  last_cursor TEXT,
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  records_processed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id BIGSERIAL PRIMARY KEY,
  migration_name TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (migration_name)
VALUES ('001_initial_417_maid_schema')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS team_messages (
  id BIGSERIAL PRIMARY KEY,
  sender TEXT NOT NULL,
  sender_role TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'general',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS team_messages_channel_idx
ON team_messages (channel, created_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','important','urgent')),
  author TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS announcements_active_idx
ON announcements (active, created_at DESC);

CREATE TABLE IF NOT EXISTS room_photos (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT REFERENCES rooms(id) ON DELETE CASCADE,
  room_number TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'reference',
  photo_url TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS room_photos_room_idx
ON room_photos (room_number, created_at DESC);

CREATE TABLE IF NOT EXISTS room_inventory (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT REFERENCES rooms(id) ON DELETE CASCADE,
  room_number TEXT NOT NULL,
  item_name TEXT NOT NULL,
  expected_quantity INTEGER NOT NULL DEFAULT 1 CHECK (expected_quantity >= 0),
  location TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS room_inventory_room_idx
ON room_inventory (room_number, active, item_name);

INSERT INTO schema_migrations (migration_name)
VALUES ('011_care_os_unified_centers')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;

BEGIN;

ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS property_name TEXT NOT NULL DEFAULT 'ALL';
ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS manual_override BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS adjustment_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS adjusted_by TEXT NOT NULL DEFAULT '';
ALTER TABLE payroll_records ADD COLUMN IF NOT EXISTS adjusted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS payroll_rates (
  id BIGSERIAL PRIMARY KEY,
  property_name TEXT NOT NULL DEFAULT 'ALL',
  room_type TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  effective_from DATE NOT NULL,
  effective_to DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL DEFAULT 'Admin',
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (property_name, room_type, effective_from)
);

CREATE INDEX IF NOT EXISTS payroll_rates_lookup_idx
ON payroll_rates (property_name, room_type, effective_from DESC)
WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS payroll_weeks (
  id BIGSERIAL PRIMARY KEY,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  snapshot_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  snapshot_records INTEGER NOT NULL DEFAULT 0,
  snapshot_employees INTEGER NOT NULL DEFAULT 0,
  snapshot_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  closed_at TIMESTAMPTZ,
  closed_by TEXT NOT NULL DEFAULT '',
  close_reason TEXT NOT NULL DEFAULT '',
  reopened_at TIMESTAMPTZ,
  reopened_by TEXT NOT NULL DEFAULT '',
  reopen_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (week_start, week_end)
);

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id BIGSERIAL PRIMARY KEY,
  payroll_record_id BIGINT REFERENCES payroll_records(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  employee TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  original_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  new_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  changed_by TEXT NOT NULL DEFAULT 'Admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payroll_audit (
  id BIGSERIAL PRIMARY KEY,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  action TEXT NOT NULL,
  employee TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  payroll_record_id BIGINT,
  changed_by TEXT NOT NULL DEFAULT 'Admin',
  reason TEXT NOT NULL DEFAULT '',
  before_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payroll_audit_week_idx
ON payroll_audit (week_start, week_end, created_at DESC);

INSERT INTO payroll_rates (property_name, room_type, amount, effective_from, created_by, reason)
VALUES
  ('ALL','3',55,'2026-01-01','System','Initial default rate'),
  ('ALL','2',45,'2026-01-01','System','Initial default rate'),
  ('ALL','1',35,'2026-01-01','System','Initial default rate'),
  ('ALL','M',20,'2026-01-01','System','Initial default rate'),
  ('ALL','S',22,'2026-01-01','System','Initial default rate'),
  ('ALL','SUITE',20,'2026-01-01','System','Initial default rate')
ON CONFLICT (property_name, room_type, effective_from) DO NOTHING;

INSERT INTO schema_migrations (migration_name)
VALUES ('002_payroll_2_complete')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS sync_queue (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT 'notion',
  dedupe_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed')),
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sync_queue_dedupe_key_unique
ON sync_queue (dedupe_key)
WHERE dedupe_key IS NOT NULL AND dedupe_key <> '';

CREATE INDEX IF NOT EXISTS sync_queue_pending_idx
ON sync_queue (status, next_retry_at, priority, created_at)
WHERE status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS sync_queue_destination_idx
ON sync_queue (destination, status, created_at DESC);

INSERT INTO schema_migrations (migration_name)
VALUES ('003_durable_sync_queue')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;


BEGIN;

CREATE TABLE IF NOT EXISTS system_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL DEFAULT 'room',
  aggregate_id TEXT NOT NULL DEFAULT '',
  work_date DATE NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'processed'
    CHECK (status IN ('pending','processing','processed','failed')),
  processed_at TIMESTAMPTZ,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS system_events_date_idx
ON system_events (work_date, occurred_at DESC);

CREATE INDEX IF NOT EXISTS system_events_aggregate_idx
ON system_events (
  aggregate_type,
  aggregate_id,
  occurred_at DESC
);

CREATE INDEX IF NOT EXISTS system_events_type_idx
ON system_events (event_type, occurred_at DESC);

ALTER TABLE payroll_records
ADD COLUMN IF NOT EXISTS source_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS payroll_records_source_event_unique
ON payroll_records (source_event_id)
WHERE source_event_id IS NOT NULL
  AND source_event_id <> '';

CREATE INDEX IF NOT EXISTS notifications_source_idx
ON notifications (source, created_at DESC);

INSERT INTO schema_migrations (migration_name)
VALUES ('004_central_event_engine')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;


BEGIN;

CREATE TABLE IF NOT EXISTS intelligence_snapshots (
  id BIGSERIAL PRIMARY KEY,
  work_date DATE NOT NULL UNIQUE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version TEXT NOT NULL DEFAULT '1.0.0',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_units INTEGER NOT NULL DEFAULT 0,
  ready_units INTEGER NOT NULL DEFAULT 0,
  active_employees INTEGER NOT NULL DEFAULT 0,
  estimated_remaining_minutes INTEGER NOT NULL DEFAULT 0,
  payroll_actual NUMERIC(12,2) NOT NULL DEFAULT 0,
  payroll_estimated NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS intelligence_snapshots_generated_idx
ON intelligence_snapshots (generated_at DESC);

INSERT INTO schema_migrations (migration_name)
VALUES ('005_real_time_intelligence_engine')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;


BEGIN;

CREATE TABLE IF NOT EXISTS ai_director_snapshots (
  id BIGSERIAL PRIMARY KEY,
  work_date DATE NOT NULL UNIQUE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version TEXT NOT NULL DEFAULT '1.0.0',
  operation_score INTEGER NOT NULL DEFAULT 0,
  operation_grade TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_director_generated_idx
ON ai_director_snapshots (generated_at DESC);

CREATE INDEX IF NOT EXISTS ai_director_score_idx
ON ai_director_snapshots (work_date, operation_score);

INSERT INTO schema_migrations (migration_name)
VALUES ('006_ai_operations_director')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;

BEGIN;

ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS pre_inspection BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS pre_inspection_started BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS pre_inspection_started_at TIMESTAMPTZ;

ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS pre_inspection_completed_at TIMESTAMPTZ;

ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  field_name TEXT NOT NULL DEFAULT '',
  old_value JSONB,
  new_value JSONB,
  changed_by TEXT NOT NULL DEFAULT 'Admin',
  changed_by_id TEXT NOT NULL DEFAULT '',
  work_date DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_audit_entity_idx
ON admin_audit_logs (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_date_idx
ON admin_audit_logs (work_date, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_actor_idx
ON admin_audit_logs (changed_by, created_at DESC);

INSERT INTO schema_migrations (migration_name)
VALUES ('007_admin_center_foundation')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;


BEGIN;

CREATE TABLE IF NOT EXISTS push_device_tokens (
  id BIGSERIAL PRIMARY KEY,
  employee_name TEXT NOT NULL,
  employee_key TEXT NOT NULL,
  employee_role TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'web',
  user_agent TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_device_employee_idx
ON push_device_tokens (employee_key, active);

CREATE INDEX IF NOT EXISTS push_device_seen_idx
ON push_device_tokens (last_seen_at DESC);

INSERT INTO schema_migrations (migration_name)
VALUES ('008_push_notifications')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  employee_name TEXT NOT NULL,
  employee_key TEXT NOT NULL,
  employee_role TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'web-push',
  user_agent TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS web_push_employee_idx
ON web_push_subscriptions (employee_key, active);

CREATE INDEX IF NOT EXISTS web_push_seen_idx
ON web_push_subscriptions (last_seen_at DESC);

INSERT INTO schema_migrations (migration_name)
VALUES ('009_standard_web_push')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS quality_reviews (
  id BIGSERIAL PRIMARY KEY,
  work_date DATE NOT NULL,
  room_id BIGINT REFERENCES rooms(id) ON DELETE SET NULL,
  unit TEXT NOT NULL,
  normalized_room TEXT NOT NULL,
  cleaner TEXT NOT NULL DEFAULT '',
  inspector TEXT NOT NULL,
  overall_score INTEGER NOT NULL DEFAULT 0 CHECK (overall_score BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','approved','correction_required')),
  first_pass BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NOT NULL DEFAULT '',
  scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_date, normalized_room, inspector)
);

CREATE INDEX IF NOT EXISTS quality_reviews_date_idx
ON quality_reviews (work_date, updated_at DESC);

CREATE INDEX IF NOT EXISTS quality_reviews_cleaner_idx
ON quality_reviews (cleaner, work_date DESC);

INSERT INTO schema_migrations (migration_name)
VALUES ('006_still_waters_quality_game')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;


BEGIN;

CREATE TABLE IF NOT EXISTS service_orders (
  id BIGSERIAL PRIMARY KEY,
  room TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','in_progress','delivered','completed','cancelled')),
  assigned_to TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  scheduled_for TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_orders_status_idx ON service_orders (status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS service_orders_room_idx ON service_orders (room, created_at DESC);
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS source_report_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS service_orders_source_report_uidx ON service_orders (source_report_id) WHERE source_report_id IS NOT NULL AND source_report_id <> '';

CREATE TABLE IF NOT EXISTS service_order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_order_events_order_idx ON service_order_events (order_id, created_at ASC);

INSERT INTO schema_migrations (migration_name) VALUES ('010_service_orders') ON CONFLICT (migration_name) DO NOTHING;

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS room_metrics (
  id BIGSERIAL PRIMARY KEY,
  work_date DATE NOT NULL,
  room_id BIGINT REFERENCES rooms(id) ON DELETE SET NULL,
  review_id BIGINT REFERENCES quality_reviews(id) ON DELETE SET NULL,
  room_number TEXT NOT NULL,
  normalized_room TEXT NOT NULL,
  room_type TEXT NOT NULL DEFAULT '',
  building TEXT NOT NULL DEFAULT 'OTHER',
  cleaner TEXT NOT NULL DEFAULT '',
  normalized_cleaner TEXT NOT NULL DEFAULT '',
  inspector TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  clean_time_minutes NUMERIC(8,1) NOT NULL DEFAULT 0,
  expected_time_minutes NUMERIC(8,1) NOT NULL DEFAULT 0,
  inspection_time_minutes NUMERIC(8,1) NOT NULL DEFAULT 0,
  difficulty TEXT NOT NULL DEFAULT 'standard' CHECK (difficulty IN ('standard','medium','hard')),
  arrival BOOLEAN NOT NULL DEFAULT FALSE,
  guest_out BOOLEAN NOT NULL DEFAULT FALSE,
  inspection_score INTEGER NOT NULL DEFAULT 100 CHECK (inspection_score BETWEEN 0 AND 100),
  quality_score INTEGER NOT NULL DEFAULT 100 CHECK (quality_score BETWEEN 0 AND 100),
  efficiency_score INTEGER NOT NULL DEFAULT 100 CHECK (efficiency_score BETWEEN 0 AND 100),
  overall_score INTEGER NOT NULL DEFAULT 100 CHECK (overall_score BETWEEN 0 AND 100),
  first_pass BOOLEAN NOT NULL DEFAULT TRUE,
  critical_errors INTEGER NOT NULL DEFAULT 0,
  major_errors INTEGER NOT NULL DEFAULT 0,
  medium_errors INTEGER NOT NULL DEFAULT 0,
  minor_errors INTEGER NOT NULL DEFAULT 0,
  issue_categories JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_date, normalized_room)
);

CREATE INDEX IF NOT EXISTS room_metrics_cleaner_idx ON room_metrics (normalized_cleaner, work_date DESC);
CREATE INDEX IF NOT EXISTS room_metrics_room_idx ON room_metrics (normalized_room, work_date DESC);
CREATE INDEX IF NOT EXISTS room_metrics_building_idx ON room_metrics (building, work_date DESC);
CREATE INDEX IF NOT EXISTS room_metrics_quality_idx ON room_metrics (work_date, overall_score);

CREATE TABLE IF NOT EXISTS employee_metrics (
  id BIGSERIAL PRIMARY KEY,
  work_date DATE NOT NULL,
  employee TEXT NOT NULL,
  normalized_employee TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Cleaner',
  rooms_completed INTEGER NOT NULL DEFAULT 0,
  average_clean_time NUMERIC(8,1) NOT NULL DEFAULT 0,
  average_expected_time NUMERIC(8,1) NOT NULL DEFAULT 0,
  average_quality_score NUMERIC(5,1) NOT NULL DEFAULT 100,
  average_efficiency_score NUMERIC(5,1) NOT NULL DEFAULT 100,
  overall_score NUMERIC(5,1) NOT NULL DEFAULT 100,
  first_pass_rate NUMERIC(5,1) NOT NULL DEFAULT 100,
  critical_errors INTEGER NOT NULL DEFAULT 0,
  major_errors INTEGER NOT NULL DEFAULT 0,
  medium_errors INTEGER NOT NULL DEFAULT 0,
  minor_errors INTEGER NOT NULL DEFAULT 0,
  recurring_issues JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_date, normalized_employee, role)
);

CREATE INDEX IF NOT EXISTS employee_metrics_employee_idx ON employee_metrics (normalized_employee, work_date DESC);
CREATE INDEX IF NOT EXISTS employee_metrics_score_idx ON employee_metrics (work_date, overall_score DESC);

INSERT INTO schema_migrations (migration_name)
VALUES ('010_operations_intelligence_quality_core')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  employee_id TEXT,
  employee_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ip_address TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

ALTER TABLE auth_sessions
ADD COLUMN IF NOT EXISTS reauthenticated_at TIMESTAMPTZ;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS pay_type TEXT NOT NULL DEFAULT 'hourly';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS unit_rate NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_locations JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS auth_sessions_active_idx
ON auth_sessions (token_hash, expires_at)
WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS security_audit_log (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT REFERENCES auth_sessions(id) ON DELETE SET NULL,
  employee_id TEXT,
  employee_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS security_audit_created_idx
ON security_audit_log (created_at DESC);

INSERT INTO schema_migrations (migration_name)
VALUES ('011_secure_auth_sessions')
ON CONFLICT (migration_name) DO NOTHING;

COMMIT;
