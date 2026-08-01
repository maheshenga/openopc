CREATE TABLE IF NOT EXISTS kortix.developer_module_payment_orders (
  order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  module_id varchar(128) NOT NULL,
  provider varchar(32) NOT NULL,
  provider_order_id varchar(128),
  merchant_order_no varchar(32) NOT NULL,
  amount_minor integer NOT NULL,
  currency varchar(3) NOT NULL,
  product_name varchar(400) NOT NULL,
  status varchar(32) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  checkout_kind varchar(16),
  checkout_url varchar(4096),
  checkout_mobile_url varchar(4096),
  provider_failure_code varchar(128),
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_payment_orders_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT developer_module_payment_orders_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT developer_module_payment_orders_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT developer_module_payment_orders_identity_unique
    UNIQUE (order_id, account_id, project_id, installation_id, release_id),
  CONSTRAINT developer_module_payment_orders_order_account_unique
    UNIQUE (order_id, account_id),
  CONSTRAINT developer_module_payment_orders_merchant_order_unique
    UNIQUE (merchant_order_no),
  CONSTRAINT developer_module_payment_orders_idempotency_unique
    UNIQUE (account_id, project_id, installation_id, release_id, idempotency_key),
  CONSTRAINT developer_module_payment_orders_amount_check
    CHECK (amount_minor > 0 AND amount_minor <= 100000000),
  CONSTRAINT developer_module_payment_orders_currency_check
    CHECK (currency = 'CNY'),
  CONSTRAINT developer_module_payment_orders_product_name_check
    CHECK (char_length(product_name) BETWEEN 1 AND 100),
  CONSTRAINT developer_module_payment_orders_state_check
    CHECK (status IN ('checkout_issued', 'paid', 'expired', 'paid_late', 'refund_requested', 'refunded', 'refund_failed')),
  CONSTRAINT developer_module_payment_orders_idempotency_check
    CHECK (idempotency_key ~ '^[ -~]{16,128}$'),
  CONSTRAINT developer_module_payment_orders_checkout_check
    CHECK (
      (checkout_kind IS NULL AND checkout_url IS NULL AND checkout_mobile_url IS NULL)
      OR (checkout_kind IN ('redirect', 'qr') AND checkout_url IS NOT NULL)
    ),
  CONSTRAINT developer_module_payment_orders_secret_check
    CHECK (
      provider_failure_code IS NULL
      OR (
        provider_failure_code !~* 'bearer'
        AND provider_failure_code !~* 'merchant[_-]?key'
        AND provider_failure_code !~* '(^|[^a-z])sign([^a-z]|$)'
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS developer_module_payment_orders_provider_order_unique
  ON kortix.developer_module_payment_orders(provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_developer_module_payment_orders_account_project
  ON kortix.developer_module_payment_orders(account_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_developer_module_payment_orders_expiry
  ON kortix.developer_module_payment_orders(status, expires_at);

CREATE TABLE IF NOT EXISTS kortix.developer_module_payment_callbacks (
  callback_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  provider varchar(32) NOT NULL,
  provider_trade_no varchar(128),
  canonical_payload_digest varchar(71) NOT NULL,
  verified boolean NOT NULL,
  outcome varchar(32) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_payment_callbacks_order_fk
    FOREIGN KEY (order_id)
    REFERENCES kortix.developer_module_payment_orders(order_id) ON DELETE CASCADE,
  CONSTRAINT developer_module_payment_callbacks_digest_check
    CHECK (canonical_payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT developer_module_payment_callbacks_outcome_check
    CHECK (outcome IN ('paid', 'paid_late', 'duplicate', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS developer_module_payment_callbacks_trade_unique
  ON kortix.developer_module_payment_callbacks(provider, provider_trade_no)
  WHERE provider_trade_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_developer_module_payment_callbacks_order
  ON kortix.developer_module_payment_callbacks(order_id, received_at);

CREATE TABLE IF NOT EXISTS kortix.developer_module_payment_refunds (
  refund_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  account_id uuid NOT NULL,
  amount_minor integer NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  provider_result jsonb,
  status varchar(32) NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT developer_module_payment_refunds_order_account_fk
    FOREIGN KEY (order_id, account_id)
    REFERENCES kortix.developer_module_payment_orders(order_id, account_id) ON DELETE CASCADE,
  CONSTRAINT developer_module_payment_refunds_identity_unique
    UNIQUE (refund_id, order_id, account_id),
  CONSTRAINT developer_module_payment_refunds_idempotency_unique
    UNIQUE (order_id, idempotency_key),
  CONSTRAINT developer_module_payment_refunds_amount_check
    CHECK (amount_minor > 0 AND amount_minor <= 100000000),
  CONSTRAINT developer_module_payment_refunds_idempotency_check
    CHECK (idempotency_key ~ '^[ -~]{16,128}$'),
  CONSTRAINT developer_module_payment_refunds_status_check
    CHECK (status IN ('refund_requested', 'refunded', 'refund_failed')),
  CONSTRAINT developer_module_payment_refunds_result_check
    CHECK (
      provider_result IS NULL
      OR (jsonb_typeof(provider_result) = 'object' AND pg_column_size(provider_result) <= 16384)
    )
);

CREATE INDEX IF NOT EXISTS idx_developer_module_payment_refunds_account
  ON kortix.developer_module_payment_refunds(account_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_developer_module_payment_refunds_order
  ON kortix.developer_module_payment_refunds(order_id, requested_at);

CREATE OR REPLACE FUNCTION kortix.reject_developer_module_payment_callback_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'developer_module_payment_callback_is_append_only';
END;
$$;

DROP TRIGGER IF EXISTS developer_module_payment_callbacks_append_only
  ON kortix.developer_module_payment_callbacks;
CREATE TRIGGER developer_module_payment_callbacks_append_only
  BEFORE UPDATE OR DELETE ON kortix.developer_module_payment_callbacks
  FOR EACH ROW EXECUTE FUNCTION kortix.reject_developer_module_payment_callback_mutation();

REVOKE ALL PRIVILEGES ON TABLE
  kortix.developer_module_payment_orders,
  kortix.developer_module_payment_callbacks,
  kortix.developer_module_payment_refunds
FROM PUBLIC, anon, authenticated, service_role;
