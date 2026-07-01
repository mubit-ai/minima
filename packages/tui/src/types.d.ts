/**
 * Ambient declarations for optional native deps that aren't installed in this package
 * (they're resolved at runtime and fall back gracefully when absent).
 */

declare module "keytar" {
  export function getPassword(service: string, account: string): Promise<string | null>;
  export function setPassword(service: string, account: string, password: string): Promise<void>;
  export function deletePassword(service: string, account: string): Promise<boolean>;
}
