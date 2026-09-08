/**
 * The account's starting deposit. All-time P&L is the current NAV minus this,
 * and the broker API does not report the opening balance, so it is set here.
 * Change it if the practice account is reset or re-funded.
 */
export const ACCOUNT_STARTING_BALANCE = 100_000;
