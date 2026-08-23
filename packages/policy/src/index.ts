/**
 * @friendszone/policy - the security kernel.
 *
 * Rules for this package, which reviewers should enforce strictly:
 *
 *  1. No I/O. No database, no network, no clock reads outside an injected
 *     value, no environment access. Every function is pure so that every
 *     decision is reproducible from its arguments alone.
 *  2. No dependencies beyond @friendszone/contracts.
 *  3. Default deny. Any new branch that grants access must be affirmative and
 *     must arrive with tests for the cases it does *not* grant.
 *
 * Design rationale: docs/security/authz-model.md
 */
export * from './viewer.js';
export * from './decision.js';
export * from './visibility.js';
export * from './projection.js';
export * from './marketplace.js';
export * from './slots.js';
export * from './actions.js';
export * from './messaging.js';
export * from './availability.js';
