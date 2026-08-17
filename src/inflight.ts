export function withInFlight(_name: string, fn: () => Promise<void>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    void fn()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
}
