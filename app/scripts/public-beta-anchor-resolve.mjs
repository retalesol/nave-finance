const WRAPPER = new URL("./public-beta-anchor-entry.mjs", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@coral-xyz/anchor") {
    return nextResolve(WRAPPER.href, context);
  }
  return nextResolve(specifier, context);
}
