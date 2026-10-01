export const DEFAULT_DATABASE_URL = 'postgres://kikit:kikit_local_only@127.0.0.1:54329/kikit';
export function requireDevelopmentFixture(): void {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? '') || process.env.KIKIT_DEV_FIXTURE !== '1') {
    throw new Error('Kikit milestone 1 requires NODE_ENV=development/test and KIKIT_DEV_FIXTURE=1. Production authentication is not implemented.');
  }
}
export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
