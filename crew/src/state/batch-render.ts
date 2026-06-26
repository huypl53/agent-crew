export interface BatchRenderableWorker {
  worker_name: string;
  final_message: string | null;
}

export function renderBatchFinalMessage(
  workers: BatchRenderableWorker[],
): string {
  return workers
    .map(
      ({ worker_name, final_message }) =>
        `## ${worker_name}\n${final_message ?? ''}`,
    )
    .join('\n\n');
}
