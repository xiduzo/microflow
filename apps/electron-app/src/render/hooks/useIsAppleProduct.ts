export function useIsAppleProduct() {
  return navigator.userAgent.match(/(Mac|iPhone|iPod|iPad)/) !== null;
}
