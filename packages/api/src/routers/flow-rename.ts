/**
 * Mirror a flow rename into the flow document's `meta.name`, best-effort.
 *
 * The flow row is the name's owner and has already committed when this runs,
 * so a failure here (store or database error) must not fail the rename: the
 * user's rename happened. The first attempt is awaited, so in the normal case
 * the document is current when the mutation returns; on failure the write is
 * retried in the background with backoff, logged each time, and given up only
 * after the last delay. The document copy only feeds filenames, so a late or
 * lost write degrades a suggestion, never the flow.
 */
export async function mirrorNameToDocument(
  flowId: string,
  name: string,
  write: (flowId: string, meta: { name: string }) => Promise<void>,
  retryDelaysMs: readonly number[] = [1_000, 5_000, 25_000],
): Promise<void> {
  const attempt = async (index: number): Promise<boolean> => {
    try {
      await write(flowId, { name });
      return true;
    } catch (error) {
      const next = retryDelaysMs[index];
      console.error(
        `[flow.update] could not write the new name into flow ${flowId}'s document` +
          (next === undefined ? "; giving up" : `; retrying in ${next}ms`),
        error,
      );
      if (next !== undefined) {
        const timer = setTimeout(() => void attempt(index + 1), next);
        // A pending retry must not hold the process open (shutdown, tests).
        (timer as { unref?: () => void }).unref?.();
      }
      return false;
    }
  };
  await attempt(0);
}
