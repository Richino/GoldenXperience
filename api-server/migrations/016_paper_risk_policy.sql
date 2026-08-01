CREATE TABLE IF NOT EXISTS paper_risk_policies (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_configuration jsonb NOT NULL DEFAULT '{"riskPercent":1,"maxSimultaneousPositions":null,"maxTotalNominalRiskPercent":null}'::jsonb,
  pending_configuration jsonb,
  collection_paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO paper_risk_policies(user_id)
SELECT id FROM users WHERE role = 'owner'
ON CONFLICT (user_id) DO NOTHING;
