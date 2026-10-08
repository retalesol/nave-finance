/*
  Allow a dedicated `planner` custody key in encrypted_agent_keys.

  The autonomous proposal path signs `create_proposal` with NAVE_PROPOSER_ROLE.
  To preserve separation of duties, planner should be a distinct key from the
  4 execution-pipeline roles.
*/

ALTER TABLE public.encrypted_agent_keys
  DROP CONSTRAINT IF EXISTS encrypted_agent_keys_agent_role_check;

ALTER TABLE public.encrypted_agent_keys
  ADD CONSTRAINT encrypted_agent_keys_agent_role_check
  CHECK (
    agent_role = ANY (
      ARRAY[
        'executive'::text,
        'financial'::text,
        'oversight'::text,
        'operational'::text,
        'planner'::text
      ]
    )
  );
