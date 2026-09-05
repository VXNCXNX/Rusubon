/** Coalesce a burst without letting later events postpone the first refresh. */
export function createRefreshScheduler(refresh, onError, delayMs = 180) {
  let timer;
  return () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      Promise.resolve().then(refresh).catch(onError);
    }, delayMs);
  };
}
