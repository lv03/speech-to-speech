/**
 * Release builds must replace this value with the public half of the
 * manifest-signing key. The private key is never part of the repository or
 * the application bundle.
 */
declare const __RUNTIME_MANIFEST_PUBLIC_KEY_PEM__: string | undefined

export const EMBEDDED_RUNTIME_MANIFEST_PUBLIC_KEY_PEM =
  typeof __RUNTIME_MANIFEST_PUBLIC_KEY_PEM__ === 'string' ? __RUNTIME_MANIFEST_PUBLIC_KEY_PEM__ : ''
