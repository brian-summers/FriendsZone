/**
 * @friendszone/design-tokens
 *
 * Design decisions as code, for the same reason domain types are:
 * one definition, no drift. A hex value that lives in both a CSS file and a
 * React component will eventually disagree with itself, and for the visibility
 * encodings that disagreement is a privacy bug rather than a cosmetic one.
 *
 * Rationale: docs/design/design-system.md
 */
export * from './color.js';
export * from './type.js';
export * from './visibility.js';
export * from './contrast.js';
