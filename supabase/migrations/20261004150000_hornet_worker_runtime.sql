-- Hornet worker runtime additions. This migration is intentionally NOT applied by this task.
-- Preserve existing workspace tables, RLS policies, queue RPCs, and data.
BEGIN;

CREATE TABLE IF NOT EXISTS public.automation_run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z0-9_.-]{1,120}$'),
  message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 1000),
  step_index integer CHECK (step_index IS NULL OR step_index >= 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_run_events_run_workspace_fk
    FOREIGN KEY (run_id, workspace_id)
    REFERENCES public.automation_runs(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS automation_run_events_workspace_run_idx
  ON public.automation_run_events(workspace_id, run_id, id);
ALTER TABLE public.automation_run_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_run_events_select_member ON public.automation_run_events;
CREATE POLICY automation_run_events_select_member ON public.automation_run_events
  FOR SELECT TO authenticated USING (private.is_workspace_member(workspace_id));
GRANT SELECT ON public.automation_run_events TO authenticated;
GRANT INSERT, SELECT ON public.automation_run_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.automation_run_events_id_seq TO service_role;
COMMENT ON TABLE public.automation_run_events IS 'Append-only workspace-scoped progress, verification evidence, and worker history. Never store credentials or raw secrets here.';

CREATE OR REPLACE FUNCTION public.pause_automation_job_for_approval(
  p_job_id uuid, p_worker_id text, p_approval_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_run_id uuid;
  v_workspace_id uuid;
  v_rows integer;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501'; END IF;
  SELECT j.run_id, j.workspace_id INTO v_run_id, v_workspace_id
    FROM public.automation_jobs AS j
    WHERE j.id = p_job_id AND j.status = 'leased' AND j.lease_owner = p_worker_id
      AND j.lease_expires_at > pg_catalog.now();
  IF v_run_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.approvals AS a WHERE a.id = p_approval_id AND a.run_id = v_run_id
      AND a.workspace_id = v_workspace_id AND a.status = 'pending'
  ) THEN RETURN false; END IF;
  UPDATE public.automation_jobs AS j SET status = 'succeeded', lease_owner = NULL,
    lease_expires_at = NULL, finished_at = pg_catalog.now(), updated_at = pg_catalog.now()
    WHERE j.id = p_job_id AND j.status = 'leased' AND j.lease_owner = p_worker_id
      AND j.lease_expires_at > pg_catalog.now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN false; END IF;
  UPDATE public.automation_runs AS r SET status = 'waiting_approval',
    result = pg_catalog.jsonb_build_object('outcome', 'NEEDS_APPROVAL', 'approval_id', p_approval_id),
    error_code = NULL, finished_at = NULL, updated_at = pg_catalog.now()
    WHERE r.id = v_run_id AND r.workspace_id = v_workspace_id AND r.status IN ('queued', 'running');
  INSERT INTO public.audit_events (workspace_id, event_type, subject_type, subject_id, details)
    VALUES (v_workspace_id, 'automation.run_waiting_approval', 'run', v_run_id::text,
      pg_catalog.jsonb_build_object('approval_id', p_approval_id));
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.pause_automation_job_for_approval(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pause_automation_job_for_approval(uuid, text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.review_approval(p_approval_id uuid, p_decision text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_workspace_id uuid;
  v_run_id uuid;
  v_rows integer;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '28000'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'invalid_decision' USING ERRCODE = '22023'; END IF;
  UPDATE public.approvals AS a SET status = p_decision, reviewed_by = v_user_id,
    reviewed_at = pg_catalog.now(), updated_at = pg_catalog.now()
    WHERE a.id = p_approval_id AND a.status = 'pending'
      AND (a.expires_at IS NULL OR a.expires_at > pg_catalog.now())
      AND private.has_workspace_role(a.workspace_id, ARRAY['owner','admin']::text[])
    RETURNING a.workspace_id, a.run_id INTO v_workspace_id, v_run_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN false; END IF;
  IF v_run_id IS NOT NULL AND p_decision = 'approved' THEN
    UPDATE public.automation_runs SET status = 'queued', error_code = NULL,
      finished_at = NULL, updated_at = pg_catalog.now()
      WHERE id = v_run_id AND workspace_id = v_workspace_id AND status = 'waiting_approval';
    UPDATE public.automation_jobs SET status = 'queued', available_at = pg_catalog.now(),
      finished_at = NULL, last_error_code = NULL, updated_at = pg_catalog.now()
      WHERE run_id = v_run_id AND workspace_id = v_workspace_id AND status = 'succeeded';
  ELSIF v_run_id IS NOT NULL AND p_decision = 'rejected' THEN
    UPDATE public.automation_runs SET status = 'failed', error_code = 'approval_rejected',
      finished_at = pg_catalog.now(), updated_at = pg_catalog.now()
      WHERE id = v_run_id AND workspace_id = v_workspace_id AND status = 'waiting_approval';
    UPDATE public.automation_jobs SET status = 'failed', last_error_code = 'approval_rejected',
      finished_at = pg_catalog.now(), updated_at = pg_catalog.now()
      WHERE run_id = v_run_id AND workspace_id = v_workspace_id AND status = 'succeeded';
  END IF;
  INSERT INTO public.audit_events (workspace_id, actor_user_id, event_type, subject_type, subject_id)
    VALUES (v_workspace_id, v_user_id, 'approval.' || p_decision, 'approval', p_approval_id::text);
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_automation_run(p_workspace_id uuid, p_run_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_rows integer;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'authentication_required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_workspace_role(p_workspace_id, ARRAY['owner','admin','member']::text[]) THEN
    RAISE EXCEPTION 'workspace_member_write_required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.automation_runs SET status = 'cancelled', error_code = NULL,
    finished_at = pg_catalog.now(), updated_at = pg_catalog.now()
    WHERE id = p_run_id AND workspace_id = p_workspace_id AND status IN ('queued','running','waiting_approval');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN false; END IF;
  UPDATE public.automation_jobs SET status = 'cancelled', lease_owner = NULL,
    lease_expires_at = NULL, finished_at = pg_catalog.now(), updated_at = pg_catalog.now()
    WHERE run_id = p_run_id AND workspace_id = p_workspace_id AND status IN ('queued','leased','succeeded');
  UPDATE public.approvals SET status = 'cancelled', updated_at = pg_catalog.now()
    WHERE run_id = p_run_id AND workspace_id = p_workspace_id AND status = 'pending';
  INSERT INTO public.audit_events (workspace_id, actor_user_id, event_type, subject_type, subject_id)
    VALUES (p_workspace_id, v_user_id, 'automation.run_cancelled', 'run', p_run_id::text);
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.cancel_automation_run(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_automation_run(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_automation_run_with_api_key(
  p_workspace_id uuid, p_automation_id uuid, p_input jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key text DEFAULT NULL::text, p_key_digest bytea DEFAULT NULL::bytea
) RETURNS TABLE(run_id uuid, job_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_run_id uuid;
  v_job_id uuid;
  v_key_id uuid;
  v_created_by uuid;
  v_automation public.automations%ROWTYPE;
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501'; END IF;
  IF p_key_digest IS NULL OR pg_catalog.octet_length(p_key_digest) <> 32 THEN
    RAISE EXCEPTION 'invalid_api_key' USING ERRCODE = '28000';
  END IF;
  IF pg_catalog.jsonb_typeof(v_input) <> 'object' OR pg_catalog.pg_column_size(v_input) > 65536 THEN
    RAISE EXCEPTION 'invalid_run_input' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NOT NULL AND char_length(p_idempotency_key) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  SELECT k.id, k.created_by INTO v_key_id, v_created_by
    FROM public.workspace_api_keys AS k
    WHERE k.workspace_id = p_workspace_id
      AND k.token_digest = p_key_digest
      AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > pg_catalog.now())
      AND k.scopes @> ARRAY['automation:trigger']::text[];
  IF v_key_id IS NULL THEN RAISE EXCEPTION 'invalid_api_key_scope' USING ERRCODE = '42501'; END IF;
  UPDATE public.workspace_api_keys SET last_used_at = pg_catalog.now() WHERE id = v_key_id;
  SELECT a.* INTO v_automation FROM public.automations AS a
    WHERE a.id = p_automation_id AND a.workspace_id = p_workspace_id AND a.enabled = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'automation_not_available' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.automation_runs (workspace_id, automation_id, requested_by, status, input, idempotency_key)
    VALUES (p_workspace_id, p_automation_id, v_created_by, 'queued', v_input, p_idempotency_key)
    ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING id INTO v_run_id;
  IF v_run_id IS NULL THEN
    SELECT r.id INTO v_run_id FROM public.automation_runs AS r
      WHERE r.workspace_id = p_workspace_id AND r.idempotency_key = p_idempotency_key;
    SELECT j.id INTO v_job_id FROM public.automation_jobs AS j WHERE j.run_id = v_run_id;
    RETURN QUERY SELECT v_run_id, v_job_id, 'queued'::text;
    RETURN;
  END IF;
  INSERT INTO public.automation_jobs (workspace_id, run_id, job_type, payload)
    VALUES (p_workspace_id, v_run_id, 'execute_automation',
      pg_catalog.jsonb_build_object('run_id', v_run_id, 'automation_id', p_automation_id))
    RETURNING id INTO v_job_id;
  INSERT INTO public.audit_events (workspace_id, actor_user_id, event_type, subject_type, subject_id, details)
    VALUES (p_workspace_id, v_created_by, 'automation.run_queued', 'run', v_run_id::text,
      pg_catalog.jsonb_build_object('source', 'workspace_api_key', 'api_key_id', v_key_id));
  RETURN QUERY SELECT v_run_id, v_job_id, 'queued'::text;
END;
$function$;
REVOKE ALL ON FUNCTION public.enqueue_automation_run_with_api_key(uuid, uuid, jsonb, text, bytea) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_automation_run_with_api_key(uuid, uuid, jsonb, text, bytea) TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_scheduled_automation_run(
  p_automation_id uuid, p_due_at timestamptz, p_next_run_at timestamptz,
  p_input jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE(run_id uuid, job_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_workspace_id uuid;
  v_definition jsonb;
  v_run_id uuid;
  v_job_id uuid;
  v_idempotency_key text;
  v_input jsonb := coalesce(p_input, '{}'::jsonb);
  v_rows integer;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501'; END IF;
  IF p_due_at IS NULL OR p_next_run_at IS NULL OR p_next_run_at <= p_due_at
     OR p_due_at > pg_catalog.now() OR pg_catalog.jsonb_typeof(v_input) <> 'object'
     OR pg_catalog.pg_column_size(v_input) > 65536 THEN
    RAISE EXCEPTION 'invalid_schedule_enqueue' USING ERRCODE = '22023';
  END IF;
  UPDATE public.automations AS a SET last_triggered_at = pg_catalog.now(),
      next_run_at = p_next_run_at, updated_at = pg_catalog.now()
    WHERE a.id = p_automation_id AND a.trigger_type = 'schedule' AND a.enabled = true
      AND a.timezone = 'UTC' AND a.next_run_at = p_due_at AND a.next_run_at <= pg_catalog.now()
    RETURNING a.workspace_id, a.definition INTO v_workspace_id, v_definition;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN; END IF;
  v_idempotency_key := 'schedule:' || p_automation_id::text || ':' ||
    pg_catalog.to_char(p_due_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISSMS"Z"');
  INSERT INTO public.automation_runs (workspace_id, automation_id, requested_by, status, input, idempotency_key)
    VALUES (v_workspace_id, p_automation_id, NULL, 'queued', v_input, v_idempotency_key)
    ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING id INTO v_run_id;
  IF v_run_id IS NULL THEN
    SELECT r.id INTO v_run_id FROM public.automation_runs AS r
      WHERE r.workspace_id = v_workspace_id AND r.idempotency_key = v_idempotency_key;
    SELECT j.id INTO v_job_id FROM public.automation_jobs AS j WHERE j.run_id = v_run_id;
    RETURN QUERY SELECT v_run_id, v_job_id, 'queued'::text;
    RETURN;
  END IF;
  INSERT INTO public.automation_jobs (workspace_id, run_id, job_type, payload)
    VALUES (v_workspace_id, v_run_id, 'execute_automation',
      pg_catalog.jsonb_build_object('run_id', v_run_id, 'automation_id', p_automation_id))
    RETURNING id INTO v_job_id;
  INSERT INTO public.audit_events (workspace_id, event_type, subject_type, subject_id, details)
    VALUES (v_workspace_id, 'automation.run_queued', 'run', v_run_id::text,
      pg_catalog.jsonb_build_object('source', 'schedule', 'due_at', p_due_at));
  RETURN QUERY SELECT v_run_id, v_job_id, 'queued'::text;
END;
$function$;
REVOKE ALL ON FUNCTION public.enqueue_scheduled_automation_run(uuid, timestamptz, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_scheduled_automation_run(uuid, timestamptz, timestamptz, jsonb) TO service_role;

-- Defense in depth: reject common credential-bearing keys and pasted-token shapes in ordinary config.
CREATE OR REPLACE FUNCTION private.contains_secret_shaped_value(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $function$
DECLARE
  v_kind text;
  v_item record;
  v_text text;
BEGIN
  IF p_value IS NULL THEN RETURN false; END IF;
  v_kind := pg_catalog.jsonb_typeof(p_value);
  IF v_kind = 'object' THEN
    FOR v_item IN SELECT key, value FROM pg_catalog.jsonb_each(p_value) LOOP
      IF v_item.key ~* '(api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|private[_-]?key|credential|authorization)' THEN
        RETURN true;
      END IF;
      IF private.contains_secret_shaped_value(v_item.value) THEN RETURN true; END IF;
    END LOOP;
  ELSIF v_kind = 'array' THEN
    FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_value) LOOP
      IF private.contains_secret_shaped_value(v_item.value) THEN RETURN true; END IF;
    END LOOP;
  ELSIF v_kind = 'string' THEN
    v_text := p_value #>> '{}';
    IF v_text ~* '(bearer[[:space:]]+[A-Za-z0-9._~-]{16,}|sk_(live|test)_[A-Za-z0-9]{12,}|(api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|private[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:]]{12,})' THEN
      RETURN true;
    END IF;
  END IF;
  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION private.reject_secret_shaped_config()
RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE
  v_config jsonb;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'automation_runs' THEN v_config := pg_catalog.to_jsonb(NEW) -> 'input';
    WHEN 'automations' THEN v_config := pg_catalog.to_jsonb(NEW) -> 'definition';
    WHEN 'agents' THEN v_config := pg_catalog.jsonb_build_object('instructions', NEW.instructions, 'config', NEW.config);
    WHEN 'skills' THEN v_config := pg_catalog.jsonb_build_object('instructions', NEW.instructions, 'manifest', NEW.manifest);
    WHEN 'mcp_connections' THEN v_config := pg_catalog.jsonb_build_object('config', NEW.config);
    ELSE RAISE EXCEPTION 'unsupported_secret_config_table' USING ERRCODE = '0A000';
  END CASE;
  IF private.contains_secret_shaped_value(v_config) THEN
    RAISE EXCEPTION 'credentials_must_use_secret_store' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.contains_secret_shaped_value(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reject_secret_shaped_config() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS automation_runs_no_secret_input ON public.automation_runs;
CREATE TRIGGER automation_runs_no_secret_input BEFORE INSERT OR UPDATE OF input ON public.automation_runs
  FOR EACH ROW EXECUTE FUNCTION private.reject_secret_shaped_config();
DROP TRIGGER IF EXISTS automations_no_secret_definition ON public.automations;
CREATE TRIGGER automations_no_secret_definition BEFORE INSERT OR UPDATE OF definition ON public.automations
  FOR EACH ROW EXECUTE FUNCTION private.reject_secret_shaped_config();
DROP TRIGGER IF EXISTS agents_no_secret_config ON public.agents;
CREATE TRIGGER agents_no_secret_config BEFORE INSERT OR UPDATE OF instructions, config ON public.agents
  FOR EACH ROW EXECUTE FUNCTION private.reject_secret_shaped_config();
DROP TRIGGER IF EXISTS skills_no_secret_content ON public.skills;
CREATE TRIGGER skills_no_secret_content BEFORE INSERT OR UPDATE OF instructions, manifest ON public.skills
  FOR EACH ROW EXECUTE FUNCTION private.reject_secret_shaped_config();
DROP TRIGGER IF EXISTS mcp_connections_no_secret_config ON public.mcp_connections;
CREATE TRIGGER mcp_connections_no_secret_config BEFORE INSERT OR UPDATE OF config ON public.mcp_connections
  FOR EACH ROW EXECUTE FUNCTION private.reject_secret_shaped_config();

COMMIT;
