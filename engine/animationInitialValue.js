// Opt-in automatic starts preserve the explicit endpoint data of older documents.
// The remembered From values return when the user enables Initial value again.
export function canUseCurrentInitialValue(animation) {
  return animation?.kind === "custom" && !animation.preset;
}

export function usesCurrentInitialValue(animation) {
  return canUseCurrentInitialValue(animation) && animation.fromCurrent === true;
}
