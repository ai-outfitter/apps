-- Existing Google grants allow several external accounts under one owner.
UPDATE connections SET multipleAccounts = 1 WHERE provider IN ('gmail', 'google-calendar');
