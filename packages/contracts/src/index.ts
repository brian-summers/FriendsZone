/**
 * @friendszone/contracts
 *
 * Every domain type in Friendszone is defined here once, as a Zod schema, and
 * the TypeScript type is inferred from it. There is no second, hand-written
 * interface anywhere in the repo that can drift from the validator.
 *
 * Rationale and rules: docs/adr/0003-contracts-first.md
 */
export * from './primitives.js';
export * from './identity.js';
export * from './social.js';
export * from './visibility.js';
export * from './calendar.js';
export * from './hangout.js';
export * from './notification.js';
export * from './marketplace.js';
export * from './moderation.js';
export * from './account.js';
export * from './auth.js';
