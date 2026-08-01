CREATE TABLE IF NOT EXISTS kortix.module_custom_domain_bindings (
  binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment varchar(16) NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  hostname varchar(253) NOT NULL,
  hostname_ascii varchar(253) NOT NULL,
  state varchar(32) NOT NULL,
  verification_token_hash varchar(71) NOT NULL,
  cloudflare_custom_hostname_id varchar(128),
  cname_target varchar(253) NOT NULL,
  failure_code varchar(128),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_custom_domain_bindings_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT module_custom_domain_bindings_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT module_custom_domain_bindings_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT module_custom_domain_bindings_identity_unique
    UNIQUE (binding_id, account_id, project_id, installation_id, release_id),
  CONSTRAINT module_custom_domain_bindings_hostname_check
    CHECK (
      char_length(hostname_ascii) BETWEEN 1 AND 253
      AND hostname_ascii = lower(hostname_ascii)
      AND hostname_ascii ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'
      AND hostname_ascii !~ '[.][.]'
      AND hostname_ascii !~ '(^|[.])-'
      AND hostname_ascii !~ '-($|[.])'
    ),
  CONSTRAINT module_custom_domain_bindings_environment_check
    CHECK (environment IN ('dev', 'staging', 'prod', 'preview')),
  CONSTRAINT module_custom_domain_bindings_hash_check
    CHECK (verification_token_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT module_custom_domain_bindings_cname_check
    CHECK (
      char_length(cname_target) BETWEEN 1 AND 253
      AND cname_target = lower(cname_target)
    ),
  CONSTRAINT module_custom_domain_bindings_state_check
    CHECK (state IN ('requested', 'dns_pending', 'hostname_pending', 'active', 'failed', 'disabled')),
  CONSTRAINT module_custom_domain_bindings_provider_state_check
    CHECK (
      (state IN ('requested', 'dns_pending') AND cloudflare_custom_hostname_id IS NULL)
      OR (state = 'hostname_pending' AND cloudflare_custom_hostname_id IS NOT NULL)
      OR (state = 'active' AND cloudflare_custom_hostname_id IS NOT NULL)
      OR state IN ('failed', 'disabled')
    ),
  CONSTRAINT module_custom_domain_bindings_failure_code_check
    CHECK (
      failure_code IS NULL
      OR (
        failure_code !~* 'bearer'
        AND failure_code !~* 'token'
        AND failure_code !~* 'key'
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS module_custom_domain_bindings_hostname_unique
  ON kortix.module_custom_domain_bindings(hostname_ascii);
CREATE INDEX IF NOT EXISTS idx_module_custom_domain_bindings_project_installation
  ON kortix.module_custom_domain_bindings(account_id, project_id, installation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_module_custom_domain_bindings_active_hostname
  ON kortix.module_custom_domain_bindings(environment, hostname_ascii, state)
  WHERE state = 'active';

REVOKE ALL PRIVILEGES ON TABLE kortix.module_custom_domain_bindings
FROM PUBLIC, anon, authenticated, service_role;
